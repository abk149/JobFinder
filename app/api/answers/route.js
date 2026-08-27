import { listAnswers, upsertAnswer, deleteAnswer } from '../../../lib/answerBank.js';
import { IDENTITY_FIELDS, isIdentityKey, validateIdentity } from '../../../lib/identity.js';
import { readJson, requireFields, withErrorHandling } from '../../../lib/http.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const profile_id = searchParams.get('profile_id');
  if (!profile_id) return Response.json({ error: 'profile_id required' }, { status: 400 });
  const rows = await listAnswers(profile_id);

  // Two lists, not one. Personal details are a short fixed set you confirm once;
  // everything else is a growing pile of replies to other people's questions, and
  // showing them together is how a "Yes" ends up looking like an email address.
  const byKey = new Map(rows.map((r) => [r.field_key, r]));
  const identity = IDENTITY_FIELDS.map((f) => {
    const row = byKey.get(f.key);
    // A rejected or parked row is not a set field, whatever it still holds. Showing
    // Showing a green tick for a value you rejected would be the panel lying to you.
    const usable = row && row.status !== 'rejected' && row.status !== 'needs_input';
    const value = usable ? (row.value || '') : '';
    const check = value
      ? validateIdentity(f.key, value)
      : { ok: false, why: row && row.status === 'rejected' ? 'you rejected this — set it here' : 'not set yet' };
    return {
      field_key: f.key,
      label: f.label,
      group: f.group,
      placeholder: f.placeholder,
      value,
      status: row?.status || 'missing',
      ok: check.ok,
      why: check.why,
    };
  });

  return Response.json({
    answers: rows,
    identity,
    // Everything that is not one of the personal fields.
    questions: rows.filter((r) => !isIdentityKey(r.field_key)),
  });
}

export const POST = withErrorHandling(async (req) => {
  const body = await readJson(req);
  const { profile_id, field_key, value, label } = body || {};
  requireFields({ profile_id, field_key }, ['profile_id', 'field_key']);

  // Refuse a personal field a value of the wrong shape, and say why. Saving is the last
  // point at which this is cheap to correct — after it, the value is on a form.
  if (isIdentityKey(field_key) && String(value || '').trim()) {
    const v = validateIdentity(field_key, value);
    if (!v.ok) return Response.json({ error: `That does not look right: ${v.why}.` }, { status: 400 });
  }

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
