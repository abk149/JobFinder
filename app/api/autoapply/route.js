// Auto-apply endpoint.
//
// POST runs a batch; GET reports what is waiting on you.
//
// `armed` is required to be sent explicitly as `true` for anything to be submitted.
// It is not stored, not remembered, and not defaulted from a setting — every live run
// has to say so in its own request. That is deliberate: a persisted "armed" flag is
// exactly the kind of state that gets left on and forgotten, and the cost of it being
// wrong is applications sent to real employers.

import { get } from '../../../lib/db.js';
import { autoApplyRun, eligibleJobs } from '../../../lib/autoApply.js';
import { listNeedsInput, countNeedsInput } from '../../../lib/answerBank.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';
import { lcmd, lwarn } from '../../../lib/logger.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 900;

export const POST = withErrorHandling(async (req) => {
  const body = await readJson(req);
  const { profile_id } = body;
  requireFields({ profile_id }, ['profile_id']);
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');

  // Only the literal boolean true arms it. A truthy "false" string from a form post
  // must not be able to send applications.
  const armed = body.armed === true;
  // Hard ceiling regardless of what the caller asks for. Both sites treat a burst of
  // applications as automation, and losing the logged-in session costs more than the
  // extra applications are worth.
  const limit = Math.max(1, Math.min(Number(body.limit) || 10, 25));

  lcmd(profile_id, armed
    ? `▶ Auto-apply — ARMED, will submit up to ${limit} application(s)`
    : `▶ Auto-apply — dry run, filling up to ${limit} form(s), submitting none`);

  const summary = await autoApplyRun(profile, { armed, limit });
  summary.needsInputTotal = await countNeedsInput(profile_id);
  if (summary.needsInputTotal) {
    lwarn(profile_id, `  ❓ ${summary.needsInputTotal} question(s) waiting for you in the answer bank.`);
  }
  return Response.json(summary);
});

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const profile_id = searchParams.get('profile_id');
  if (!profile_id) return Response.json({ error: 'profile_id required' }, { status: 400 });
  const [questions, jobs] = await Promise.all([
    listNeedsInput(profile_id),
    eligibleJobs(profile_id, 200),
  ]);
  return Response.json({
    questions,
    eligible: jobs.length,
    byConnector: jobs.reduce((a, j) => ({ ...a, [j.connector]: (a[j.connector] || 0) + 1 }), {}),
  });
}
