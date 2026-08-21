// Safe Mode endpoint — escape hatch for "verify you are human" challenges.
//
// Closes the automated (CDP-attached) Chrome for the profile and relaunches plain
// Chrome at the same URLs on the same user-data-dir. Logins / cookies persist; bot
// detectors can't flag the window because there is literally no automation attached.
//
// Usage: POST { profile_id }

import { get } from '../../../lib/db.js';
import { switchToSafeMode } from '../../../lib/browser.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (req) => {
  const { profile_id } = await readJson(req);
  requireFields({ profile_id }, ['profile_id']);
  const profile = await get('SELECT id FROM profiles WHERE id = ?', [profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');

  const result = await switchToSafeMode(profile_id);
  return Response.json(result);
});
