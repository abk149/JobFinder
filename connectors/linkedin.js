import { jobId, buildKeywordQuery, firstLocation, safeText, safeAttr, humanDelay, detectWall, wallError } from './_util.js';

// LinkedIn jobs via the PUBLIC guest endpoint.
//
// The old approach loaded /jobs/search/ in a logged-in session and read
// div.job-card-container. Two things were wrong with that:
//
//   1. Logged out (the normal state) that URL serves a sign-in wall, so the scan
//      found nothing and reported the source as "down or blocking us".
//   2. Those class names no longer exist. Measured on the live page:
//      div.job-card-container → 0 elements, div.base-card → 60. Every field lookup
//      then waited out Playwright's 30s default, and 4 lookups × 30s hit the
//      connector's 120s budget — which is what "timed out after 120s" actually was.
//
// jobs-guest/.../seeMoreJobPostings returns a plain <ul> of job cards with stable
// class names, needs no authentication, and answers in well under a second. Verified
// live: HTTP 200, 10 cards, title/company/location/href all populated.
const GUEST_SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const PAGES = 3;          // 10 cards per page
const PER_PAGE = 10;

export default {
  id: 'linkedin',
  label: 'LinkedIn',
  loginUrl: 'https://www.linkedin.com/login',
  // The guest endpoint is public. Logging in is still useful (it improves relevance
  // and is required for Easy Apply), but a scan no longer depends on it.
  requiresAuth: false,
  requiresBrowser: true,

  async scan(ctx, profile) {
    const page = await ctx.newPage();
    const kw = buildKeywordQuery(profile) || 'software engineer';
    const loc = firstLocation(profile);
    const out = [];
    const seen = new Set();

    try {
      for (let i = 0; i < PAGES; i++) {
        const url = `${GUEST_SEARCH}?keywords=${encodeURIComponent(kw)}`
          + `&location=${encodeURIComponent(loc)}&start=${i * PER_PAGE}`;

        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (!res || !res.ok()) {
          // 429 is LinkedIn rate-limiting us; anything we already collected is good.
          if (res && res.status() === 429) break;
          const wall = await detectWall(page);
          if (wall) throw wallError(wall, wallMessage(wall));
          if (i === 0) throw new Error(`LinkedIn returned HTTP ${res ? res.status() : '(no response)'}`);
          break;
        }

        const cards = await page.locator('div.base-card').all();
        if (!cards.length) break; // ran past the last page of results

        for (const card of cards) {
          const title = await safeText(card.locator('h3.base-search-card__title').first());
          const href = await safeAttr(card.locator('a.base-card__full-link').first(), 'href');
          if (!title || !href) continue;
          const ext = href.split('?')[0];
          if (seen.has(ext)) continue;
          seen.add(ext);
          out.push({
            id: jobId('linkedin', ext),
            external_id: ext,
            title,
            company: await safeText(card.locator('h4.base-search-card__subtitle').first()),
            location: await safeText(card.locator('span.job-search-card__location').first()),
            url: href,
            salary: '',
            posted_at: await safeAttr(card.locator('time').first(), 'datetime'),
            description: '',
          });
        }
        await humanDelay(400, 900);
      }

      // ── Easy Apply pass ──────────────────────────────────────────────────
      //
      // The guest endpoint above is public, which is why scanning works logged out —
      // but it never says whether a posting is Easy Apply, and most are not. Auto-apply
      // therefore had to open each one to find out: in a measured batch it opened 34
      // postings to find 4 it could actually drive.
      //
      // The authenticated search takes f_AL=true, which returns ONLY Easy Apply jobs.
      // Those are the ones that can be applied to without leaving LinkedIn, so they are
      // collected here and tagged, and auto-apply can go straight to them.
      //
      // Best-effort and additive: it needs a signed-in session, and if there isn't one
      // the guest results above stand on their own exactly as before.
      try {
        const easyUrl = 'https://www.linkedin.com/jobs/search/?f_AL=true'
          + `&keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(loc)}`;
        await page.goto(easyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await humanDelay(2500, 4000);
        const easy = await page.evaluate(() => {
          const seenIds = new Set();
          const rows = [];
          for (const card of document.querySelectorAll('[data-job-id]')) {
            const id = card.getAttribute('data-job-id');
            if (!id || !/^\d+$/.test(id) || seenIds.has(id)) continue;
            seenIds.add(id);
            const t = card.querySelector('a.job-card-container__link, a.job-card-list__title, strong');
            const c = card.querySelector('.artdeco-entity-lockup__subtitle, .job-card-container__primary-description');
            const l = card.querySelector('.job-card-container__metadata-item, .artdeco-entity-lockup__caption');
            rows.push({
              id,
              title: (t?.innerText || '').trim().split('\n')[0],
              company: (c?.innerText || '').trim().split('\n')[0],
              location: (l?.innerText || '').trim().split('\n')[0],
            });
          }
          return rows;
        });
        for (const e of easy) {
          if (!e.title) continue;
          const ext = `https://www.linkedin.com/jobs/view/${e.id}`;
          if (seen.has(ext)) continue;
          seen.add(ext);
          out.push({
            id: jobId('linkedin', ext),
            external_id: ext,
            title: e.title,
            company: e.company || '',
            location: e.location || '',
            url: ext,
            salary: '',
            posted_at: '',
            description: '',
            // The whole point: these came from the Easy Apply filter, so auto-apply
            // never has to open one to discover it redirects elsewhere.
            apply_kind: 'internal',
          });
        }
      } catch { /* not signed in, or LinkedIn changed the search page — guest results stand */ }
    } finally {
      await page.close().catch(() => {});
    }
    return out;
  },

  async apply(ctx, profile, job) {
    const page = await ctx.newPage();
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await humanDelay(1000, 2500);
    const easyBtn = page.locator('button:has-text("Easy Apply")').first();
    if (await easyBtn.count().catch(() => 0)) {
      await easyBtn.click().catch(() => {});
      return { status: 'opened', note: 'Easy Apply opened — complete the form in the browser window.' };
    }
    return { status: 'opened', note: 'Job page opened — external apply.' };
  },
};

function wallMessage(wall) {
  if (wall === 'login') {
    return 'LinkedIn is showing a sign-in wall. Open Sources → LinkedIn → "Open & log in", sign in, leave the window open, then scan again.';
  }
  if (wall === 'captcha') {
    return 'LinkedIn is showing a human-verification check. Open Sources → LinkedIn → "Open & log in", clear the check, then scan again.';
  }
  return 'LinkedIn is blocking this request.';
}
