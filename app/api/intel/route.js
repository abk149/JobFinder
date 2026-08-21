// Job intelligence: salary/negotiation, referral contacts, and recruiter-email parsing.
// Grouped in one route because each is a small, job-scoped lookup.
//
//   POST { action:'salary',    job_id }                → market band + negotiation script
//   POST { action:'referrals', job_id }                → possible contacts at the company
//   POST { action:'email',     profile_id, text }      → what this reply means + which job

import { get } from '../../../lib/db.js';
import { marketRange, negotiationBrief } from '../../../lib/salary.js';
import { findReferrals } from '../../../lib/referrals.js';
import { matchJob, classifyEmail } from '../../../lib/inbox.js';
import { withAttachedContext } from '../../../lib/browser.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';
import { lcmd, linfo, lok, lwarn } from '../../../lib/logger.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const POST = withErrorHandling(async (req) => {
  const body = await readJson(req);
  const { action } = body;
  requireFields({ action }, ['action']);

  // ── Salary + negotiation ─────────────────────────────────────────────────
  if (action === 'salary') {
    requireFields(body, ['job_id']);
    const job = await get('SELECT * FROM jobs WHERE id = ?', [body.job_id]);
    if (!job) throw new HttpError(404, 'job not found');
    const profile = await get('SELECT * FROM profiles WHERE id = ?', [job.profile_id]);

    lcmd(job.profile_id, `▶ Salary intel for ${job.title}`);
    const market = await marketRange(job.profile_id, job);
    linfo(job.profile_id, `  ${market.sample} postings with usable salary data. ${market.note}`);
    const brief = await negotiationBrief(profile, job, market).catch(() => null);
    lok(job.profile_id, '■ Salary brief ready');
    return Response.json({ ok: true, market, brief, posted: job.salary || null });
  }

  // ── Referral contacts ────────────────────────────────────────────────────
  if (action === 'referrals') {
    requireFields(body, ['job_id']);
    const job = await get('SELECT * FROM jobs WHERE id = ?', [body.job_id]);
    if (!job) throw new HttpError(404, 'job not found');
    if (!job.company) throw new HttpError(400, 'this posting has no company name');

    lcmd(job.profile_id, `▶ Looking for contacts at ${job.company}`);
    try {
      const result = await withAttachedContext(job.profile_id, async (ctx) =>
        findReferrals(ctx, job.company, { pid: job.profile_id })
      );
      return Response.json({ ok: true, ...result });
    } catch (e) {
      // No open browser is the common case — say so usefully rather than 500ing.
      lwarn(job.profile_id, `  ${String(e?.message || e).slice(0, 140)}`);
      return Response.json({
        ok: false,
        reason: 'Needs an open, logged-in LinkedIn window. Go to Sources → LinkedIn → "Open & log in", then retry.',
        people: [],
      });
    }
  }

  // ── Recruiter email → pipeline stage ─────────────────────────────────────
  if (action === 'email') {
    requireFields(body, ['profile_id', 'text']);
    const profile = await get('SELECT * FROM profiles WHERE id = ?', [body.profile_id]);
    if (!profile) throw new HttpError(404, 'profile not found');

    lcmd(body.profile_id, '▶ Reading recruiter reply');
    const [match, verdict] = await Promise.all([
      matchJob(body.profile_id, body.text),
      classifyEmail(profile, body.text),
    ]);

    if (!verdict) {
      lwarn(body.profile_id, '  Could not classify that email.');
      return Response.json({ ok: false, reason: 'Could not read that email. Try pasting more of it.' });
    }
    lok(
      body.profile_id,
      `■ Reads as "${verdict.stage}"${match.best ? ` — likely ${match.best.company} / ${match.best.title}` : ' — no matching saved job'}`
    );

    // Deliberately does NOT apply the change: it proposes, the user confirms. A
    // wrong auto-update silently corrupts the funnel metrics you rely on.
    return Response.json({
      ok: true,
      verdict,
      match: {
        best: match.best,
        confident: match.confident,
        candidates: match.candidates,
      },
    });
  }

  throw new HttpError(400, `unknown action "${action}"`);
});
