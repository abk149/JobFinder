// Triggers the autofill engine against the live browser context for a given job.
// Usage: POST { job_id, useLLM?, overwrite? }

import { get } from '../../../lib/db.js';
import { withAttachedContext, openInChrome } from '../../../lib/browser.js';
import { harvestContext } from '../../../lib/harvest.js';
import { autofillContext } from '../../../lib/autofill.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';
import { linfo, lwarn } from '../../../lib/logger.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// mode:
//   'standard'    — exact + semantic only, no LLM
//   'llm-fallback' — standard + LLM for unfilled (default; what the "Autofill" button uses)
//   'llm-force'   — LLM tries every detected field (what the "LLM Fill" button uses)
//
// (`useLLM` kept for back-compat with older callers — true → 'llm-fallback', false → 'standard'.)
export const POST = withErrorHandling(async (req) => {
  const body = await readJson(req);
  const { job_id, overwrite = false, allPages = false } = body;
  let { mode } = body;
  if (!mode) mode = body.useLLM === false ? 'standard' : 'llm-fallback';
  if (!['standard', 'llm-fallback', 'llm-force'].includes(mode)) mode = 'llm-fallback';

  requireFields({ job_id }, ['job_id']);
  const job = await get('SELECT * FROM jobs WHERE id = ?', [job_id]);
  if (!job) throw new HttpError(404, 'job not found');
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [job.profile_id]);

  // LAZY-ATTACH: connect Playwright to the user's already-open Chrome ONLY for the
  // duration of the fill, then disconnect. The verification step the user runs
  // after autofill executes against a window with no live automation client.
  //
  // If no Chrome window is open for this profile, openInChrome spins one up at the
  // job URL first (still without an attached Playwright client). Autofill then
  // attaches transiently to that fresh window.
  try {
    const summary = await withAttachedContext(job.profile_id, async (ctx) => {
      // Open the job URL if no tabs are visible (rare — usually the user clicked
      // Apply first which already opened it).
      const openPages = ctx.pages().filter((p) => !p.isClosed());
      if (!openPages.length) {
        const page = await ctx.newPage();
        try { await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch { /* ignore */ }
        await page.waitForTimeout(1500);
      }
      // Drain anything the page buffered while nothing was attached — typically
      // everything you typed after the LAST autofill and before submitting. Do this
      // BEFORE filling, so the bank can immediately reuse those answers here.
      //
      // includeCurrent also snapshots what's on screen right now. That matters most
      // when overwrite is set: in that mode the fill path deliberately skips its own
      // `prefilled` capture and clobbers your values, so this is the only chance to
      // record them. It's also the safety net for the very first visit, where Chrome
      // was launched with no Playwright and the observer wasn't installed until now.
      const harvested = await harvestContext(ctx, job.profile_id, { includeCurrent: true })
        .catch(() => ({ learned: 0 }));

      const result = await autofillContext(ctx, profile, job, { mode, overwrite, allPages });
      result.learnedFromPage = harvested.learned || 0;
      return result;
    });
    linfo(job.profile_id, '  Detached automation — window is back to plain Chrome. Verify away.');
    return Response.json({ ok: true, summary });
  } catch (e) {
    // Most common cause: user hit Autofill before clicking Apply, so there's no
    // browser window yet. Open one and tell them what happened.
    if (String(e?.message || e).includes('No browser open')) {
      lwarn(job.profile_id, `  ⚠ No browser window open — opening ${job.url || 'the application page'} now. Try Autofill again once it loads.`);
      try { await openInChrome(job.profile_id, job.url); } catch { /* ignore */ }
      throw new HttpError(409, 'Browser window was not open — opened it for you. Click Autofill again once the page has loaded.');
    }
    throw e;
  }
});
