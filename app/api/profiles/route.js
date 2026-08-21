import crypto from 'node:crypto';
import { all, run, backendName } from '../../../lib/db.js';
import { serializeFilters } from '../../../lib/profileSettings.js';
import { readJson, requireFields, withErrorHandling } from '../../../lib/http.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const rows = await all('SELECT * FROM profiles ORDER BY created_at DESC');
  return Response.json({ profiles: rows, backend: backendName() });
}

export const POST = withErrorHandling(async (req) => {
  const body = await readJson(req);
  requireFields(body, ['name']);
  const id = crypto.randomUUID();
  await run(
    'INSERT INTO profiles (id, name, email, resume_path, keywords, locations, filters, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [
      id,
      body.name || 'Untitled',
      body.email || '',
      body.resume_path || '',
      body.keywords || '',
      body.locations || '',
      serializeFilters(body.filters),
      Date.now(),
    ]
  );
  return Response.json({ id });
});
