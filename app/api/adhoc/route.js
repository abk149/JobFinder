// Paste a job link → a real job row, opened in your browser, ready to autofill.
//
// POST { profile_id, url, autofill?: 'none'|'llm-fallback'|'llm-force' }
//
// Everything downstream (autofill, cover letters, CV matching, the tracker, the in-page
// toolbar) works off a job row, so the whole job of this route is to manufacture one
// faithfully from a URL and then hand over to the existing machinery.

import { get } from '../../../lib/db.js';
import { openInChrome, withAttachedContext, discoverRunningChrome } from '../../../lib/browser.js';
import { extractJobFromPage, saveAdhocJob } from '../../../lib/adhocJob.js';
import { autofillContext } from '../../../lib/autofill.js';
import { harvestContext } from '../../../lib/harvest.js';
import { startKeeper } from '../../../lib/toolbarKeeper.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';
import { lcmd, lok, lwarn } from '../../../lib/logger.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function normaliseUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;   // people paste bare hosts
  try { return new URL(u).toString(); } catch { return ''; }
}

export const POST = withErrorHandling(async (req) => {
  const body = await readJson(req);
  const { profile_id, autofill = 'llm-fallback' } = body;
  requireFields({ profile_id }, ['profile_id']);

  const url = normaliseUrl(body.url);
  if (!url) throw new HttpError(400, 'That does not look like a URL.');

  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');

  lcmd(profile_id, `▶ Importing pasted link — ${url.slice(0, 90)}`);

  // Open it in YOUR Chrome. A posting behind a login or a bot check then reads exactly
  // as it does for you, which a fresh headless browser could not manage.
  try {
    await openInChrome(profile_id, url);
  } catch (e) {
    throw new HttpError(502, `Could not open a browser window: ${e?.message || e}`);
  }

  // Give the page a moment, then read it during one transient attach.
  await new Promise((r) => setTimeout(r, 3500));

  let fields;
  try {
    fields = await withAttachedContext(profile_id, async (ctx) => {
      const pages = ctx.pages().filter((p) => !p.isClosed());
      // Match on origin+path: the site may have appended tracking params or redirected.
      let target = null;
      try {
        const want = new URL(url);
        target = pages.find((p) => {
          try {
            const got = new URL(p.url());
            return got.host === want.host && got.pathname.startsWith(want.pathname.slice(0, 40));
          } catch { return false; }
        });
      } catch { /* fall through */ }
      const page = target || pages[pages.length - 1];
      if (!page) throw new Error('The page did not open.');
      try { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch { /* good enough */ }
      return await extractJobFromPage(page, profile, url);
    });
  } catch (e) {
    throw new HttpError(502, `Opened the page but could not read it: ${String(e?.message || e).slice(0, 160)}`);
  }

  const job = await saveAdhocJob(profile_id, url, fields);
  lok(
    profile_id,
    `  ✓ Imported "${job.title}"${job.company ? ' @ ' + job.company : ''}` +
    ` — ${String(job.description || '').length} chars of description` +
    ` (${fields.hadStructuredData ? 'structured JobPosting data' : 'read from the page'})`
  );

  // Arm the in-page toolbar for this application, exactly as Apply does.
  try {
    const port = await discoverRunningChrome(profile_id);
    const origin = new URL(req.url).origin;
    const k = await startKeeper(profile_id, { port, jobId: job.id, origin });
    if (k.ok) lok(profile_id, '  🎯 Toolbar armed — Alt+Shift+F fill · L LLM · S learn');
  } catch { /* the bookmarklet still works */ }

  // Optionally fill straight away.
  let summary = null;
  if (autofill && autofill !== 'none') {
    try {
      summary = await withAttachedContext(profile_id, async (ctx) => {
        await harvestContext(ctx, profile_id, { includeCurrent: true }).catch(() => null);
        return await autofillContext(ctx, profile, job, { mode: autofill, overwrite: false });
      });
    } catch (e) {
      lwarn(profile_id, `  ⚠ Imported, but autofill failed: ${String(e?.message || e).slice(0, 120)}`);
    }
  }

  const filled = summary ? (summary.filled || 0) + (summary.semanticFilled || 0) + (summary.llmFilled || 0) : 0;
  return Response.json({
    ok: true,
    job,
    structured: fields.hadStructuredData,
    summary,
    message:
      `Imported "${job.title}"${job.company ? ' @ ' + job.company : ''}.` +
      (summary ? ` Filled ${filled} field${filled === 1 ? '' : 's'}.` : ' Opened in your browser.'),
  });
});
