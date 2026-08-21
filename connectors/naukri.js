import { jobId, buildKeywordQuery, firstLocation, safeText, safeAttr, humanDelay, waitForCaptcha, detectWall } from './_util.js';

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
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    if (res && res.status() === 403) {
      await page.close().catch(() => {});
      throw new Error('Naukri blocked the request (Akamai "Access Denied"). Open Sources → Naukri → "Open & log in", sign in, leave that window open, then scan again.');
    }
    await waitForCaptcha(page);
    const wall = await detectWall(page);
    if (wall) {
      await page.close().catch(() => {});
      throw new Error(wall === 'blocked'
        ? 'Naukri blocked the request. Open Sources → Naukri → "Open & log in", sign in, leave that window open, then scan again.'
        : 'Naukri is asking you to sign in. Open Sources → Naukri → "Open & log in", then scan again.');
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
      out.push({
        id: jobId('naukri', ext),
        external_id: ext, title, company, location, url: href,
        salary, posted_at: '', description: '',
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
