import { jobId, keywordList, matchesKeywords, humanDelay, waitForCaptcha, externalApply } from './_util.js';

// Otta — now part of Welcome to the Jungle (otta.com redirects there; app.otta.com
// redirects to their login).
//
// REQUIRES LOGIN. Verified against the live site: /en/jobs is a marketing funnel
// ("Upload your resume", "3 steps to the job that fits") and every job link on it
// points at /authenticate/signin. There is no anonymous job search any more.
//
// Nor is there a usable API: api.welcometothejungle.com/api/v1/search/jobs is a
// private Algolia proxy that rejects each parameter set in turn
// (analytics → attributesToHighlight → page …), so it is not a contract worth
// depending on.
//
// Therefore this behaves like LinkedIn/Naukri here: log in once via
// Sources → "Open & log in", and the scan reuses that session. If the session has
// expired we detect the sign-in wall and say so, rather than silently returning
// zero jobs and looking like a broken scraper.

// The search route lives on the www host under /en/jobs; regional hosts
// (uk.welcometothejungle.com) serve a landing page and 404 on /jobs.
const BASE = 'https://www.welcometothejungle.com';
const SEARCH = `${BASE}/en/jobs`;

export default {
  id: 'otta',
  label: 'Otta / Welcome to the Jungle',
  loginUrl: `${BASE}/en/authenticate/signin`,
  requiresAuth: true,     // job results are behind a sign-in wall
  requiresBrowser: true,  // no usable public API — see note above

  async scan(ctx, profile) {
    if (!ctx) return [];
    const kws = keywordList(profile);
    const terms = kws.length ? kws.slice(0, 3) : ['software engineer'];

    const page = await ctx.newPage();
    const out = [];
    const seen = new Set();

    try {
      for (const term of terms) {
        if (out.length >= 60) break;
        const url = `${SEARCH}?query=${encodeURIComponent(term)}`;
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        } catch {
          continue; // slow page — try the next term
        }
        await waitForCaptcha(page);
        await humanDelay(2500, 4000);

        // Detect the sign-in wall explicitly. Without this the connector just
        // returns nothing and looks broken, when the real fix is one click.
        const walled = await page.evaluate(() => {
          if (/\/authenticate\/signin/.test(location.pathname)) return true;
          const anchors = [...document.querySelectorAll('a[href*="/jobs/"]')];
          const real = anchors.filter((a) => /\/companies\/[^/]+\/jobs\//.test(a.getAttribute('href') || ''));
          const signin = document.querySelectorAll('a[href*="/authenticate/signin"]').length;
          // Plenty of sign-in prompts and no actual job links ⇒ logged out.
          return real.length === 0 && signin > 3;
        }).catch(() => false);

        if (walled) {
          throw new Error(
            'Welcome to the Jungle is showing its sign-in wall. Open Sources → "Otta / Welcome to the Jungle" → "Open & log in", sign in, leave the window open, then scan again.'
          );
        }

        // Results render client-side; scroll to pull more in.
        for (let i = 0; i < 4; i++) {
          await page.mouse.wheel(0, 1600).catch(() => {});
          await humanDelay(700, 1200);
        }

        const found = await page.evaluate(() => {
          const res = [];
          const seenHref = new Set();
          // WTTJ job links look like /companies/<co>/jobs/<slug>. Anchoring on the
          // URL shape rather than CSS class names survives styling changes.
          for (const a of document.querySelectorAll('a[href*="/jobs/"]')) {
            const href = a.getAttribute('href') || '';
            if (!/\/companies\/[^/]+\/jobs\//.test(href)) continue;
            if (seenHref.has(href)) continue;
            seenHref.add(href);

            // Walk up to the card that holds the title + company + location text.
            let card = a;
            for (let i = 0; i < 4 && card.parentElement; i++) {
              if ((card.innerText || '').trim().length > 25) break;
              card = card.parentElement;
            }
            const text = (card.innerText || '').trim();
            const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
            if (!lines.length) continue;

            const coMatch = href.match(/\/companies\/([^/]+)\//);
            res.push({
              href,
              title: (a.innerText || lines[0] || '').trim().slice(0, 140),
              companySlug: coMatch ? coMatch[1] : '',
              blob: lines.slice(0, 6).join(' · ').slice(0, 300),
            });
            if (res.length >= 40) break;
          }
          return res;
        }).catch(() => []);

        for (const f of found) {
          if (!f.title || f.title.length < 3) continue;
          const url2 = f.href.startsWith('http') ? f.href : `${BASE}${f.href}`;
          if (seen.has(url2)) continue;

          const company = f.companySlug
            .split('-').filter(Boolean)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');

          if (!matchesKeywords(`${f.title} ${company} ${f.blob}`, kws)) continue;
          seen.add(url2);
          out.push({
            id: jobId('otta', url2),
            external_id: url2,
            title: f.title,
            company,
            location: 'See posting',
            url: url2,
            salary: '',
            posted_at: '',
            description: f.blob,
          });
          if (out.length >= 60) break;
        }
      }
    } finally {
      await page.close().catch(() => {});
    }
    return out;
  },

  apply: externalApply('Welcome to the Jungle posting opened — complete the application there.'),
};
