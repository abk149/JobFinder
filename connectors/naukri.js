import { jobId, buildKeywordQuery, firstLocation, safeText, safeAttr, humanDelay, waitForCaptcha, detectWall, wallError } from './_util.js';

// Naukri sits behind Akamai bot protection. From a fresh automated browser it answers
// "Access Denied" (measured: HTTP 403) — it generally only works once you have logged
// in through "Open & log in" and that window is still open, which warms the session.
//
// Previously that 403 produced an empty page, every card selector missed, and each
// missing field waited out Playwright's 30s default — 5 fields deep, the connector
// blew its 120s budget and reported "timed out", telling you nothing useful. Now the
// block is detected up front and reported as the actionable thing it is.

export default {
  id: 'naukri',
  label: 'Naukri',
  loginUrl: 'https://www.naukri.com/nlogin/login',
  requiresAuth: true,
  requiresBrowser: true,

  async scan(ctx, profile) {
    const page = await ctx.newPage();
    const kw = (buildKeywordQuery(profile) || 'software engineer').replace(/\s+/g, '-');
    const loc = firstLocation(profile).replace(/\s+/g, '-').toLowerCase();
    const url = `https://www.naukri.com/${encodeURIComponent(kw)}-jobs${loc ? `-in-${encodeURIComponent(loc)}` : ''}`;

    // ── Which of these can actually be applied to ON Naukri? ──────────────────
    //
    // Most Naukri results are "Apply on company site": the button just bounces you to
    // the employer's own careers page, so auto-apply can do nothing with them. Finding
    // that out by opening each posting costs ~5s a job and, before this, filled whole
    // batches with results nobody could act on.
    //
    // The search page asks Naukri's own API for the results it renders, and that answer
    // already contains the flag: companyApplyJob=true means the employer's site owns the
    // application. So read the response the page fetches anyway — no extra request, no
    // guessing at the API's required headers, and nothing to keep in sync if the card
    // markup changes again.
    const applyKind = new Map();   // numeric job id -> 'internal' | 'external'
    page.on('response', async (r) => {
      if (!/\/jobapi\/v\d\/search/.test(r.url())) return;
      try {
        const body = await r.json();
        for (const j of body.jobDetails || body.jobs || []) {
          if (!j || j.jobId == null) continue;
          applyKind.set(String(j.jobId), j.companyApplyJob ? 'external' : 'internal');
        }
      } catch { /* not the payload we wanted */ }
    });

    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    if (res && res.status() === 403) {
      await page.close().catch(() => {});
      throw wallError('login', 'Naukri blocked the request (Akamai "Access Denied"). Sign in on the window I opened, leave it open, then scan again.');
    }
    await waitForCaptcha(page);
    const wall = await detectWall(page);
    if (wall) {
      await page.close().catch(() => {});
      throw wall === 'blocked'
        ? wallError('blocked', 'Naukri blocked the request. Try again later — signing in will not help.')
        : wallError(wall, 'Naukri is asking you to sign in. Sign in on the window I opened, then scan again.');
    }
    await humanDelay(2500, 4500);

    // Naukri has shipped three card layouts; accept whichever is live.
    const cards = await page.locator('article.jobTuple, div.srp-jobtuple-wrapper, div.cust-job-tuple').all();
    if (!cards.length) {
      await page.close().catch(() => {});
      throw new Error('Naukri returned a page with no job cards — its markup has likely changed again.');
    }
    const out = [];
    for (const card of cards.slice(0, 25)) {
      const titleEl = card.locator('a.title, a.jobTitle').first();
      // NOTE: every safeText/safeAttr below is now capped at 2.5s (see _util.js), so a
      // stale selector costs seconds across the whole page instead of 30s per field.
      const title = await safeText(titleEl);
      const href = await safeAttr(titleEl, 'href');
      const company = await safeText(card.locator('a.subTitle, a.companyName, a.comp-name').first());
      const location = await safeText(card.locator('span.locWdth, span.location').first());
      const salary = await safeText(card.locator('span.salary, span.sal').first());
      if (!title || !href) continue;
      const ext = href.split('?')[0];
      // Naukri puts the numeric job id at the end of the slug, which is the same id the
      // search API keys its results by.
      const numeric = (ext.match(/(\d{6,})(?:\?|$)/) || [])[1] || '';
      out.push({
        id: jobId('naukri', ext),
        external_id: ext, title, company, location, url: href,
        salary, posted_at: '', description: '',
        apply_kind: applyKind.get(numeric) || null,
      });
    }
    await page.close();
    return out;
  },

  async apply(ctx, profile, job) {
    const page = await ctx.newPage();
    await page.goto(job.url, { waitUntil: 'domcontentloaded' });
    await waitForCaptcha(page);
    await humanDelay(1000, 2500);
    const btn = page.locator('button:has-text("Apply"), #apply-button').first();
    if (await btn.count()) await btn.click().catch(() => {});
    return { status: 'opened', note: 'Naukri job opened — confirm application in browser.' };
  },
};
