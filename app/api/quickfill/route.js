// Endpoint for the in-page toolbar / hotkeys (extension/).
//
// The page only knows its own URL — it has no job_id — so this resolves which job you
// are on before doing the same work the dashboard buttons do.
//
// SECURITY: this endpoint IS reachable cross-origin, because the toolbar runs on the
// job site's own page. That would otherwise let any site you browse drive your local
// automation, so every call must carry the token from lib/quickToken.js — which exists
// only in your bookmarklet, never in any page. Without a valid token this 401s before
// touching the browser or the database.

import { get, all } from '../../../lib/db.js';
import { withAttachedContext } from '../../../lib/browser.js';
import { harvestContext } from '../../../lib/harvest.js';
import { autofillContext } from '../../../lib/autofill.js';
import { readJson, requireFields, withErrorHandling } from '../../../lib/http.js';
import { lcmd, lwarn } from '../../../lib/logger.js';
import { tokenValid, corsHeaders } from '../../../lib/quickToken.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function sameTarget(jobUrl, pageUrl) {
  try {
    const a = new URL(jobUrl);
    const b = new URL(pageUrl);
    if (a.host !== b.host) return false;
    // ATS flows walk through /apply, /step2, ?tab=… — the path prefix is the stable part.
    return b.pathname.startsWith(a.pathname) || a.pathname.startsWith(b.pathname);
  } catch { return false; }
}

/**
 * Which job is this page? Exact URL, then same-host path overlap, then the job you
 * most recently clicked Apply on — which is nearly always the right answer, since
 * that click is what opened this window.
 */
async function resolveJob(pageUrl) {
  const exact = await get('SELECT * FROM jobs WHERE url = ?', [pageUrl]);
  if (exact) return { job: exact, how: 'exact URL' };

  let host = '';
  try { host = new URL(pageUrl).host; } catch { /* ignore */ }
  if (host) {
    const candidates = await all(
      "SELECT * FROM jobs WHERE url LIKE ? ORDER BY COALESCE(applied_at, discovered_at) DESC LIMIT 50",
      [`%${host}%`]
    );
    const match = candidates.find((j) => sameTarget(j.url, pageUrl));
    if (match) return { job: match, how: 'matched by URL' };
  }

  const recent = await get(
    "SELECT * FROM jobs WHERE status IN ('in_progress','applied') AND applied_at IS NOT NULL ORDER BY applied_at DESC LIMIT 1"
  );
  if (recent) return { job: recent, how: 'most recent Apply' };
  return { job: null, how: 'none' };
}

export async function OPTIONS(req) {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export const POST = withErrorHandling(async (req) => {
  const cors = corsHeaders(req);
  const { url, mode = 'llm-fallback', token } = await readJson(req);
  if (!tokenValid(token)) {
    return Response.json({ ok: false, error: 'Invalid or missing toolbar token.' }, { status: 401, headers: cors });
  }
  requireFields({ url }, ['url']);

  const { job, how } = await resolveJob(url);
  if (!job) {
    return Response.json({
      ok: false,
      error: 'No matching job. Click Apply on a job in JobFinder first.',
    }, { headers: cors });
  }
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [job.profile_id]);
  if (!profile) return Response.json({ ok: false, error: 'profile not found' }, { headers: cors });

  const what = mode === 'learn' ? 'Learn page' : mode === 'llm-force' ? 'LLM Fill' : 'Autofill';
  lcmd(job.profile_id, `▶ ${what} from the in-page toolbar — ${job.title || job.id} (${how})`);

  try {
    return await withAttachedContext(job.profile_id, async (ctx) => {
      if (mode === 'learn') {
        const r = await harvestContext(ctx, job.profile_id, { includeCurrent: true });
        return Response.json({
          ok: true,
          message: r.learned
            ? `Captured ${r.learned} answer${r.learned === 1 ? '' : 's'}. Approve them in Answer bank before they're used.`
            : 'Nothing new to learn on this page.',
          learned: r.learned,
        }, { headers: cors });
      }

      // Same order as the dashboard: bank what you typed first, then fill.
      const harvested = await harvestContext(ctx, job.profile_id, { includeCurrent: true })
        .catch(() => ({ learned: 0 }));
      const s = await autofillContext(ctx, profile, job, { mode, overwrite: false, allPages: false });

      const total = (s.filled || 0) + (s.semanticFilled || 0) + (s.llmFilled || 0);
      const bits = [];
      if (total) bits.push(`Filled ${total} field${total === 1 ? '' : 's'}`);
      else bits.push('No fields filled');
      if (s.protected) bits.push(`kept your text in ${s.protected}`);
      if (harvested.learned) bits.push(`captured ${harvested.learned} for review`);
      if (s.skipped) bits.push(`${s.skipped} skipped`);

      return Response.json({ ok: true, message: bits.join(' · ') + '.', summary: s }, { headers: cors });
    });
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('No browser open')) {
      lwarn(job.profile_id, '  ⚠ Toolbar action ignored — JobFinder has no browser session for this profile.');
      return Response.json({ ok: false, error: 'JobFinder isn’t attached to this window. Open the job via Apply.' }, { headers: cors });
    }
    throw e;
  }
});
