import { listAnswers, upsertAnswer, deleteAnswer } from '../../../lib/answerBank.js';
import { readJson, requireFields, withErrorHandling } from '../../../lib/http.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const profile_id = searchParams.get('profile_id');
  if (!profile_id) return Response.json({ error: 'profile_id required' }, { status: 400 });
  const rows = await listAnswers(profile_id);
  return Response.json({ answers: rows });
}

export const POST = withErrorHandling(async (req) => {
  const body = await readJson(req);
  const { profile_id, field_key, value, label } = body || {};
  requireFields({ profile_id, field_key }, ['profile_id', 'field_key']);
  await upsertAnswer(profile_id, field_key, value || '', label || '');
  return Response.json({ ok: true });
});

export async function DELETE(req) {
  const { searchParams } = new URL(req.url);
  const profile_id = searchParams.get('profile_id');
  const field_key = searchParams.get('field_key');
  if (!profile_id || !field_key) return Response.json({ error: 'profile_id and field_key required' }, { status: 400 });
  await deleteAnswer(profile_id, field_key);
  return Response.json({ ok: true });
}
