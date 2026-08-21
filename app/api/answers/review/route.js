// Bulk review of newly captured answers.
//
// Anything the observer learns from a page arrives as 'pending' and is invisible to
// autofill and to the LLM's grounding context until it is approved here. That is the
// safety valve: a bad capture can no longer quietly become the answer every future
// application inherits.
//
//   GET  ?profile_id=…&status=pending   → rows awaiting review
//   POST { profile_id, decision, keys } → approve/reject those field_keys
//   POST { profile_id, decision, all:true } → approve/reject everything pending

import {
  listAnswers,
  reviewAnswers,
  reviewAllPending,
  countPending,
} from '../../../../lib/answerBank.js';
import { readJson, requireFields, withErrorHandling } from '../../../../lib/http.js';
import { lok, linfo } from '../../../../lib/logger.js';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req) => {
  const { searchParams } = new URL(req.url);
  const profile_id = searchParams.get('profile_id');
  requireFields({ profile_id }, ['profile_id']);
  const status = searchParams.get('status') || 'pending';
  const rows = await listAnswers(profile_id, { status });
  return Response.json({ answers: rows, pending: await countPending(profile_id) });
});

export const POST = withErrorHandling(async (req) => {
  const { profile_id, decision, keys, all } = (await readJson(req)) || {};
  requireFields({ profile_id, decision }, ['profile_id', 'decision']);

  const n = all
    ? await reviewAllPending(profile_id, decision)
    : await reviewAnswers(profile_id, keys || [], decision);

  const verb = decision === 'approved' ? 'Approved' : 'Rejected';
  if (n) lok(profile_id, `  ${decision === 'approved' ? '✓' : '✗'} ${verb} ${n} answer(s) for the bank`);
  else linfo(profile_id, '  Nothing to review.');

  return Response.json({ ok: true, changed: n, pending: await countPending(profile_id) });
});
