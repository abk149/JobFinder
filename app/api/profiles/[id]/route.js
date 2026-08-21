import { get, run } from '../../../../lib/db.js';
import { serializeFilters } from '../../../../lib/profileSettings.js';
import { readJson, withErrorHandling, HttpError } from '../../../../lib/http.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [params.id]);
  if (!profile) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json({ profile });
}

export const PUT = withErrorHandling(async (req, { params }) => {
  const body = await readJson(req);
  const existing = await get('SELECT id FROM profiles WHERE id = ?', [params.id]);
  if (!existing) throw new HttpError(404, 'profile not found');
  await run(
    'UPDATE profiles SET name=?, email=?, resume_path=?, keywords=?, locations=?, filters=? WHERE id=?',
    [
      body.name || '',
      body.email || '',
      body.resume_path || '',
      body.keywords || '',
      body.locations || '',
      serializeFilters(body.filters),
      params.id,
    ]
  );
  return Response.json({ ok: true });
});

export async function DELETE(_req, { params }) {
  await run('DELETE FROM jobs WHERE profile_id = ?', [params.id]);
  await run('DELETE FROM connector_sessions WHERE profile_id = ?', [params.id]);
  await run('DELETE FROM scan_runs WHERE profile_id = ?', [params.id]);
  await run('DELETE FROM profiles WHERE id = ?', [params.id]);
  return Response.json({ ok: true });
}
