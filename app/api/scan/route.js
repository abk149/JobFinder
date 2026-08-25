// Scan endpoint: a thin wrapper over lib/scanRunner.js.
//
// The scanning itself was moved into lib/ so the auto-apply scheduler can run the same
// code path; this file is now just request parsing and the HTTP response.

import { get, all } from '../../../lib/db.js';
import { scanConnectors } from '../../../lib/scanRunner.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

export const POST = withErrorHandling(async (req) => {
  const { profile_id, connectors } = await readJson(req);
  requireFields({ profile_id }, ['profile_id']);
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');

  // The work lives in lib/scanRunner.js so the auto-apply scheduler runs exactly the
  // same scan rather than a second copy that drifts.
  const { results, needsYou } = await scanConnectors(profile, connectors);
  return Response.json({ results, needsYou });
});

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const profile_id = searchParams.get('profile_id');
  const rows = await all(
    'SELECT * FROM scan_runs WHERE profile_id = ? ORDER BY started_at DESC LIMIT 50',
    [profile_id]
  );
  return Response.json({ runs: rows });
}
