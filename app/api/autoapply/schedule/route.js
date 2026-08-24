// The auto-apply schedule: read it, change it, stop it.
//
// Arming here is the same contract as a manual run — only the literal boolean true —
// but with one difference that matters: this one is remembered, because a scheduler you
// must re-arm after every restart is not a scheduler. What makes that survivable is the
// daily cap, which is derived from applications actually sent rather than from a
// counter this process keeps, so nothing can reset it back to zero.

import { scheduleStatus, setSchedule } from '../../../../lib/scheduler.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../../lib/http.js';
import { ensureSchedulerStarted } from '../../../../lib/schedulerBoot.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  ensureSchedulerStarted();
  const { searchParams } = new URL(req.url);
  const profile_id = searchParams.get('profile_id');
  if (!profile_id) return Response.json({ error: 'profile_id required' }, { status: 400 });
  const status = await scheduleStatus(profile_id);
  if (!status) return Response.json({ error: 'profile not found' }, { status: 404 });
  return Response.json(status);
}

export const POST = withErrorHandling(async (req) => {
  const body = await readJson(req);
  const { profile_id } = body;
  requireFields({ profile_id }, ['profile_id']);
  try {
    const cfg = await setSchedule(profile_id, {
      enabled: body.enabled,
      armed: body.armed,
      everyMinutes: body.everyMinutes,
      limit: body.limit,
      dailyCap: body.dailyCap,
    });
    return Response.json({ ok: true, ...(await scheduleStatus(profile_id)), ...cfg });
  } catch (e) {
    throw new HttpError(400, String(e?.message || e));
  }
});
