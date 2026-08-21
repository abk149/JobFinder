// Application pipeline tracker: funnel metrics and follow-up management.
//
//   GET   /api/tracker?profile_id=X            → funnel stats + due follow-ups
//   PATCH /api/tracker { job_id, status?, follow_up_at?, notes?, contact? }
//
// Stage changes auto-schedule the next follow-up (applied → nudge in 10 days) unless
// the caller supplies its own date, so the common path needs no extra clicks.

import { get, all, run } from '../../../lib/db.js';
import { funnel, dueFollowUps, isValidStage, defaultFollowUp, STAGES } from '../../../lib/pipeline.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';
import { linfo } from '../../../lib/logger.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const profileId = searchParams.get('profile_id');
  if (!profileId) return Response.json({ error: 'profile_id required' }, { status: 400 });

  const jobs = await all(
    `SELECT id, title, company, url, status, applied_at, follow_up_at, notes, contact, fit_score
       FROM jobs WHERE profile_id = ?`,
    [profileId]
  );

  return Response.json({
    ok: true,
    stages: STAGES,
    funnel: funnel(jobs),
    dueFollowUps: dueFollowUps(jobs).slice(0, 25),
  });
}

export const PATCH = withErrorHandling(async (req) => {
  const body = await readJson(req);
  const { job_id, status, follow_up_at, notes, contact, clearFollowUp } = body;
  requireFields({ job_id }, ['job_id']);

  const job = await get('SELECT * FROM jobs WHERE id = ?', [job_id]);
  if (!job) throw new HttpError(404, 'job not found');

  const sets = [];
  const params = [];

  if (status !== undefined) {
    if (!isValidStage(status)) throw new HttpError(400, `invalid status "${status}"`);
    sets.push('status = ?', 'status_changed_at = ?');
    params.push(status, Date.now());
    // Record the first time it actually reached "applied".
    if (status === 'applied' && !job.applied_at) { sets.push('applied_at = ?'); params.push(Date.now()); }
    // Auto-schedule the next nudge unless the caller specified one.
    if (follow_up_at === undefined && !clearFollowUp) {
      const next = defaultFollowUp(status);
      if (next) { sets.push('follow_up_at = ?'); params.push(next); }
      else { sets.push('follow_up_at = ?'); params.push(null); } // terminal stages stop nagging
    }
    linfo(job.profile_id, `  ${job.title || 'job'} → ${status}`);
  }

  if (clearFollowUp) { sets.push('follow_up_at = ?'); params.push(null); }
  else if (follow_up_at !== undefined) { sets.push('follow_up_at = ?'); params.push(follow_up_at || null); }
  if (notes !== undefined) { sets.push('notes = ?'); params.push(String(notes).slice(0, 4000)); }
  if (contact !== undefined) { sets.push('contact = ?'); params.push(String(contact).slice(0, 300)); }

  if (!sets.length) throw new HttpError(400, 'nothing to update');

  params.push(job_id);
  await run(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, params);

  const updated = await get(
    'SELECT id, status, follow_up_at, notes, contact, applied_at FROM jobs WHERE id = ?',
    [job_id]
  );
  return Response.json({ ok: true, job: updated });
});
