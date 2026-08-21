// Login route — opens a connector's login URL in the profile's lazy-attach Chrome.
// Same model as Apply: real Chrome window, no Playwright client attached, so Google
// OAuth and any "verify you are human" check see ordinary Chrome and behave normally.
//
// The session is shared per profile — once the user logs in here, every other
// connector (and the autofill flow) uses the same cookies via the same user-data-dir.

import { get, run } from '../../../lib/db.js';
import { openInChrome } from '../../../lib/browser.js';
import { getConnector } from '../../../connectors/index.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';
import { lcmd, lok, lerr } from '../../../lib/logger.js';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (req) => {
  const { profile_id, connector } = await readJson(req);
  requireFields({ profile_id, connector }, ['profile_id', 'connector']);
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');
  const c = getConnector(connector);
  if (!c) throw new HttpError(404, 'unknown connector');

  lcmd(profile_id, `▶ Open & log in: ${c.label}`);
  try {
    const result = await openInChrome(profile_id, c.loginUrl);
    lok(profile_id, `  ✓ Opened ${c.label} — no automation attached. Sign in normally and leave the window open.`);
    await run(
      `INSERT INTO connector_sessions (profile_id, connector, status, last_login_at)
       VALUES (?,?,?,?)
       ON CONFLICT(profile_id, connector) DO UPDATE SET status=excluded.status, last_login_at=excluded.last_login_at`,
      [profile_id, connector, 'logged-in', Date.now()]
    );
    return Response.json({
      ok: true,
      ...result,
      message: `Opened ${c.label}. Log in / solve any human-check in that window and LEAVE IT OPEN — no automation is attached. Autofill attaches transiently only when you ask it to.`,
    });
  } catch (e) {
    lerr(profile_id, `  ✗ Login open failed: ${e?.message || e}`);
    throw e;
  }
});
