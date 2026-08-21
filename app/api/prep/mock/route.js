// Mock interview.
//   POST /api/prep/mock { profile_id, action:'question', topic?, asked?[] }
//   POST /api/prep/mock { profile_id, action:'grade', question, answer }
//
// Stateless — the client owns the transcript, so a refresh doesn't lose your session.

import { get } from '../../../../lib/db.js';
import { nextQuestion, gradeAnswer } from '../../../../lib/prep/mock.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../../lib/http.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const POST = withErrorHandling(async (req) => {
  const { profile_id, action, topic, asked, question, answer } = await readJson(req);
  requireFields({ profile_id, action }, ['profile_id', 'action']);

  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');

  if (action === 'question') {
    return Response.json(await nextQuestion(profile, { topic: topic || null, asked: asked || [] }));
  }
  if (action === 'grade') {
    requireFields({ question, answer }, ['question', 'answer']);
    return Response.json(await gradeAnswer(profile, question, answer));
  }
  throw new HttpError(400, `unknown action "${action}"`);
});
