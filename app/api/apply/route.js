// Apply route — opens the job's application URL in the profile's lazy-attach Chrome.
//
// LAZY-ATTACH MODEL: Chrome runs with --remote-debugging-port enabled but with NO
// Playwright client connected. To web JS the window looks like ordinary Chrome —
// navigator.webdriver is undefined, no automation infobar, no CDP-client signals.
// This is what makes "verify your application" steps pass.
//
// When the user later clicks Autofill, we transiently connect via CDP, fill the
// form, and disconnect. The verification step they hit after that runs against
// a window with no live automation client.

import { get, run } from '../../../lib/db.js';
import { openInChrome } from '../../../lib/browser.js';
import { getConnector } from '../../../connectors/index.js';
import { shouldAdvance } from '../../../lib/pipeline.js';
import { discoverRunningChrome, withAttachedContext } from '../../../lib/browser.js';
import { startKeeper } from '../../../lib/toolbarKeeper.js';
import { injectToolbar } from '../../../lib/injectToolbar.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';
import { lcmd, lok, lerr, lwarn } from '../../../lib/logger.js';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (req) => {
  const { job_id } = await readJson(req);
  requireFields({ job_id }, ['job_id']);
  const job = await get('SELECT * FROM jobs WHERE id = ?', [job_id]);
  if (!job) throw new HttpError(404, 'job not found');
  const connector = getConnector(job.connector);
  if (!connector) throw new HttpError(404, 'unknown connector');

  lcmd(job.profile_id, `▶ Apply: ${job.title || job_id} @ ${job.company || job.connector}`);

  try {
    const r = await openInChrome(job.profile_id, job.url);
    lok(job.profile_id, `  ✓ Opened ${r.openedNewTab ? 'as new tab in existing window' : 'in fresh Chrome window'} — no automation attached. Verification will see plain Chrome.`);

    // Put the toolbar on this page. Default path is a TRANSIENT attach: connect, inject,
    // disconnect — the window you work in has no automation client, exactly as before.
    // Opting into JOBFINDER_TOOLBAR_KEEPER=1 instead holds a session open so the toolbar
    // survives navigation; that trade is described in lib/toolbarKeeper.js.
    const origin = new URL(req.url).origin;
    let armed = false;
    try {
      const port = await discoverRunningChrome(job.profile_id);
      const k = await startKeeper(job.profile_id, { port, jobId: job.id, origin });
      if (k.ok) {
        armed = true;
        lok(job.profile_id, '  🎯 Toolbar armed for EVERY page of this application — it follows you through the form. Alt+Shift+F fill · L LLM · S learn');
      }
    } catch { /* fall through to the transient path */ }

    if (!armed) {
      (async () => {
        try {
          await new Promise((res) => setTimeout(res, 2500)); // let the page settle
          const frames = await withAttachedContext(job.profile_id, (ctx) => injectToolbar(ctx, { origin }));
          lok(job.profile_id, frames
            ? `  🎯 Toolbar ready in ${frames} frame(s). Detached again — nothing is attached to this window.`
            : '  Toolbar not injected (page not ready) — use the bookmarklet.');
        } catch { /* page closed or navigated — the bookmarklet still works */ }
      })();
    }
    // Only move the job FORWARD. Re-opening one you already applied to (or that is in
    // screening / interview / offer) must not drag it back to "in progress" — that
    // silently destroys pipeline state you rely on. Retrying a skipped/rejected job
    // does advance, because that is a deliberate second attempt.
    if (shouldAdvance(job.status, 'in_progress')) {
      await run(
        'UPDATE jobs SET status = ?, applied_at = COALESCE(applied_at, ?) WHERE id = ?',
        ['in_progress', Date.now(), job_id]
      );
    } else {
      lok(job.profile_id, `  Stage left at "${job.status}" — Apply never moves a job backwards.`);
    }
    return Response.json({
      status: 'opened',
      note: 'Opened the application in your browser. Fill anything you need to manually, then click Autofill / LLM Fill — automation attaches just for the fill and detaches before verification.',
    });
  } catch (e) {
    lerr(job.profile_id, `  ✗ Apply failed: ${e?.message || e}`);
    throw e;
  }
});
