// Referral finder — who might get your application off the pile.
//
// A referral converts far better than a cold application, so "do I know anyone
// here?" is one of the highest-value questions you can ask before applying. There
// is no API for this: it means driving your logged-in LinkedIn session.
//
// HONEST LIMITATIONS, stated up front because this is the most fragile feature here:
//   • Requires an open, logged-in LinkedIn window (the shared browser context).
//   • LinkedIn rewrites its markup regularly; selectors WILL break periodically.
//     Everything is wrapped so a break returns "found nobody", never a crash.
//   • It only reads a public search page — the same thing you'd see by typing the
//     search yourself. It does not message anyone or take any action on your behalf.

import { linfo, lwarn } from './logger.js';

/**
 * Search LinkedIn for people at a company, preferring 1st/2nd-degree connections.
 *
 * @param ctx      logged-in browser context (from withAttachedContext)
 * @param company  company name
 * @returns { ok, people:[{name,headline,degree,url}], reason }
 */
export async function findReferrals(ctx, company, { pid = null, limit = 12 } = {}) {
  if (!ctx) return { ok: false, reason: 'No open browser. Use "Open & log in" on LinkedIn first.', people: [] };
  const name = String(company || '').trim();
  if (!name) return { ok: false, reason: 'No company name on this posting.', people: [] };

  let page;
  try {
    page = await ctx.newPage();
    const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(name)}&network=%5B%22F%22%2C%22S%22%5D`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(3000);

    // If LinkedIn bounced us to a login/checkpoint page, say so plainly.
    const current = page.url();
    if (/\/login|\/checkpoint|\/authwall/.test(current)) {
      return { ok: false, reason: 'LinkedIn wants you to log in. Use "Open & log in" on the Sources tab, then retry.', people: [] };
    }

    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 1400).catch(() => {});
      await page.waitForTimeout(700);
    }

    const people = await page.evaluate(() => {
      const out = [];
      // LinkedIn's people results are list items containing a /in/ profile link.
      const seen = new Set();
      for (const li of document.querySelectorAll('li')) {
        const a = li.querySelector('a[href*="/in/"]');
        if (!a) continue;
        const href = (a.getAttribute('href') || '').split('?')[0];
        if (!href || seen.has(href)) continue;
        const text = (li.innerText || '').trim();
        if (text.length < 5) continue;
        const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
        // Line 0 is usually the name; a "· 2nd" marker rides along with it.
        const nameLine = lines.find((l) => l.length > 1 && !/^\d/.test(l)) || '';
        const degreeMatch = text.match(/\b(1st|2nd|3rd)\b/);
        const headline = lines.find((l) => l !== nameLine && l.length > 8 && !/^\d/.test(l)) || '';
        seen.add(href);
        out.push({
          name: nameLine.replace(/\s*·?\s*(1st|2nd|3rd).*$/, '').trim().slice(0, 80),
          headline: headline.slice(0, 120),
          degree: degreeMatch ? degreeMatch[1] : '',
          url: href.startsWith('http') ? href : `https://www.linkedin.com${href}`,
        });
        if (out.length >= 25) break;
      }
      return out;
    }).catch(() => []);

    // Keep entries that actually look like people, prefer closer connections.
    const cleaned = people
      .filter((p) => p.name && p.name.length > 2 && !/^linkedin/i.test(p.name))
      .sort((a, b) => (a.degree === '1st' ? -1 : 0) - (b.degree === '1st' ? -1 : 0))
      .slice(0, limit);

    if (pid) {
      if (cleaned.length) linfo(pid, `  🤝 Found ${cleaned.length} possible contact(s) at ${name}`);
      else lwarn(pid, `  No contacts found at ${name} (LinkedIn markup may have changed, or you have no connections there).`);
    }
    return { ok: true, people: cleaned, company: name };
  } catch (e) {
    if (pid) lwarn(pid, `  Referral lookup failed: ${String(e?.message || e).slice(0, 120)}`);
    return { ok: false, reason: String(e?.message || e).slice(0, 160), people: [] };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
