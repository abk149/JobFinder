// "Learn page" — capture everything currently on the open application form into the
// answer bank, without filling anything.
//
// POST { profile_id }
//
// Autofill already drains the buffer when it runs, but the most valuable moment is
// the one where you've just finished typing and are about to submit — and at that
// point you don't want anything written to the form. This does the capture only.

import { get } from '../../../lib/db.js';
import { withAttachedContext } from '../../../lib/browser.js';
import { harvestContext } from '../../../lib/harvest.js';
import { countPending } from '../../../lib/answerBank.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';
import { lcmd, lwarn } from '../../../lib/logger.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export const POST = withErrorHandling(async (req) => {
  const { profile_id } = await readJson(req);
  requireFields({ profile_id }, ['profile_id']);
  const profile = await get('SELECT id FROM profiles WHERE id = ?', [profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');

  lcmd(profile_id, '▶ Learning from the open page');

  try {
    // includeCurrent: snapshot what's on screen too, not just the buffer — so this
    // works even on a form filled before the observer script was installed.
    const result = await withAttachedContext(profile_id, (ctx) =>
      harvestContext(ctx, profile_id, { includeCurrent: true })
    );
    // Captured answers are parked as 'pending' — tell the UI how many need a decision.
    return Response.json({ ok: true, ...result, pending: await countPending(profile_id) });
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('No browser open')) {
      lwarn(profile_id, '  ⚠ No browser window open — open the application first, then hit Learn page.');
      return Response.json({
        ok: false,
        reason: 'No browser window is open. Open the application (Apply), fill it in, then hit "Learn page".',
      });
    }
    throw e;
  }
});
