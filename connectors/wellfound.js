import { jobId, buildKeywordQuery, humanDelay, waitForCaptcha, keywordList, matchesKeywords, withFetched } from './_util.js';

export default {
  id: 'wellfound',
  label: 'Wellfound (AngelList)',
  loginUrl: 'https://wellfound.com/login',
  requiresAuth: true,
  requiresBrowser: true,

  async scan(ctx, profile) {
    const page = await ctx.newPage();
    const q = encodeURIComponent(buildKeywordQuery(profile) || 'engineer');
    await page.goto(`https://wellfound.com/jobs?keywords=${q}`, { waitUntil: 'domcontentloaded' });
    await waitForCaptcha(page);
    await humanDelay(3000, 5000);

    // Wellfound sits behind Cloudflare and 403s anything it doesn't like. When the
    // challenge holds, the page renders essentially empty — without this check the
    // connector just reports "0 jobs" and looks broken, when the real fix is to log
    // in once so the session carries a clearance cookie.
    const blocked = await page.evaluate(() => {
      const text = (document.body?.innerText || '').trim();
      if (text.length > 400) return false;
      return /just a moment|checking your browser|verify you are human|enable javascript/i.test(text) || text.length < 60;
    }).catch(() => false);
    if (blocked) {
      throw new Error(
        'Wellfound is behind a Cloudflare check. Open Sources → Wellfound → "Open & log in", clear the check, leave the window open, then scan again.'
      );
    }
    // Anchor on the URL SHAPE, not CSS classes. The previous selector included
    // `div.styles_component__uTjVj` — a hashed CSS-module name that changes on
    // every Wellfound build, so it was guaranteed to rot. Link paths are part of
    // their routing and change far less often.
    const found = await page.evaluate(() => {
      const res = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/jobs/"]')) {
        const href = a.getAttribute('href') || '';
        if (!/\/jobs\/\d|\/company\/[^/]+\/jobs\//.test(href)) continue;
        if (seen.has(href)) continue;
        seen.add(href);

        // Climb to the card that carries the surrounding company/location text.
        let card = a;
        for (let i = 0; i < 4 && card.parentElement; i++) {
          if ((card.innerText || '').trim().length > 30) break;
          card = card.parentElement;
        }
        const lines = (card.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
        const title = (a.innerText || lines[0] || '').trim();
        if (!title || title.length < 3) continue;

        const coEl = card.querySelector('a[href*="/company/"]');
        res.push({
          href,
          title: title.slice(0, 140),
          company: (coEl?.innerText || lines.find((l) => l !== title) || '').trim().slice(0, 80),
          blob: lines.slice(0, 5).join(' · ').slice(0, 240),
        });
        if (res.length >= 25) break;
      }
      return res;
    }).catch(() => []);

    const out = [];
    const fetchedCount = found.length;
    for (const f of found) {
      const fullUrl = f.href.startsWith('http') ? f.href : `https://wellfound.com${f.href}`;
      if (!matchesKeywords(`${f.title} ${f.company} ${f.blob}`, keywordList(profile))) continue;
      out.push({
        id: jobId('wellfound', fullUrl),
        external_id: fullUrl,
        title: f.title,
        company: f.company,
        location: 'Remote/Hybrid',
        url: fullUrl,
        salary: '', posted_at: '', description: f.blob,
      });
    }
    await page.close();
    return withFetched(out, fetchedCount);
  },

  async apply(ctx, profile, job) {
    const page = await ctx.newPage();
    await page.goto(job.url, { waitUntil: 'domcontentloaded' });
    const btn = page.locator('button:has-text("Apply")').first();
    if (await btn.count()) await btn.click().catch(() => {});
    return { status: 'opened', note: 'Wellfound application opened.' };
  },
};
