import { jobId, keywordList, matchesKeywords, humanDelay, waitForCaptcha, withFetched, detectWall } from './_util.js';

// Scan the LOGGED-IN LinkedIn feed + keyword search for *posts* (not the formal Jobs
// board) where someone is announcing an opening — the classic "We're hiring! DM me /
// comment 'interested'" posts that never make it to the Jobs tab.
//
// Requires the user to be logged in (use "Open & log in" on the linkedin source first;
// the session is shared per-profile, so this connector reuses those cookies).
//
// Strategy: hit LinkedIn's content search for each keyword with a hiring phrase, then
// also the home feed, and harvest post text + permalink. Heuristics decide if a post
// is an offer. This is best-effort scraping: selectors can shift, so everything is
// wrapped defensively and we simply return whatever we could extract.

const HIRING_PHRASES = [
  'hiring', 'we are hiring', "we're hiring", 'job opening', 'open role',
  'open position', 'now hiring', 'join our team', 'apply now', 'dm me',
  'comment interested', 'looking for', 'vacancy', 'recruiting',
];

function looksLikeOffer(text) {
  const t = (text || '').toLowerCase();
  return HIRING_PHRASES.some((p) => t.includes(p));
}

// Build a few LinkedIn content-search URLs from the profile keywords.
function searchUrls(profile) {
  const kws = keywordList(profile);
  const terms = kws.length ? kws : ['software engineer'];
  const urls = [];
  for (const term of terms.slice(0, 3)) {
    const q = encodeURIComponent(`${term} hiring`);
    urls.push(`https://www.linkedin.com/search/results/content/?keywords=${q}&sortBy=%22date_posted%22`);
  }
  return urls;
}

const POST_SEL = 'div.feed-shared-update-v2, div[data-urn*="urn:li:activity"]';

// LinkedIn's content search no longer exposes anything stable to select on. Measured
// live on a signed-in session: div.feed-shared-update-v2 → 0, [data-urn] → 0,
// a[href*="/feed/update/"] → 0, [role=article] → 0. Every class on the page is a
// per-build hash (._45cd63c2), so any class-based selector breaks on LinkedIn's next
// deploy. That is deliberate anti-scraping, not a bug we can select our way around.
//
// So identify posts STRUCTURALLY instead: every post carries an author link to /in/,
// and the post body is the nearest ancestor holding a meaningful amount of text. That
// survives class churn because it relies on the page's shape, not its styling.
//
// Trade-off worth knowing: the per-post permalink is not in the DOM at all, so results
// link to the author's profile. You can still find and act on the post from there.
async function extractStructural(page) {
  return await page.evaluate(() => {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/in/"]')) {
      let el = a;
      let container = null;
      for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
        if ((el.innerText || '').trim().length > 180) { container = el; break; }
      }
      if (!container || seen.has(container)) continue;
      seen.add(container);

      let text = (container.innerText || '').trim();
      if (!text || text.length > 4000) continue;
      text = text.replace(/^Feed post\s*/i, '');

      // A post renders as metadata then content:
      //   "<Author> • 3rd+ <headline> 2m • Follow <the actual post…>"
      // Strip the preamble line by line, otherwise the "title" ends up being the
      // author's name repeated back — useless for judging whether a post is worth
      // opening.
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const author = (lines[0] || '').split('•')[0].trim().slice(0, 80) || 'LinkedIn member';
      // The post body begins after the last metadata marker — the relative timestamp
      // ("2m", "3d") or the Follow control. Anchoring there skips the author name AND
      // their headline, both of which otherwise get mistaken for the post itself.
      const MARKER = /^(\d+\s*[smhdw]\b.*|.*•\s*follow.*|follow|edited)$/i;
      let start = -1;
      for (let i = 0; i < Math.min(lines.length, 8); i++) if (MARKER.test(lines[i])) start = i;
      const rest = start >= 0 ? lines.slice(start + 1) : lines.slice(2);
      const body = rest.filter((l) => !/^(see more|…more|activate to view larger image)$/i.test(l))
        .join('\n').trim() || text;
      const profile = (a.getAttribute('href') || '').split('?')[0];
      out.push({
        activityId: '',
        urn: profile,
        author,
        profileUrl: profile.startsWith('http') ? profile : `https://www.linkedin.com${profile}`,
        text: body.slice(0, 3000),
      });
    }
    return out;
  }).catch(() => []);
}

async function harvestPosts(page) {
  // Scroll to lazy-load more posts, but stop as soon as a scroll stops producing any —
  // the old version always did 5 blind scrolls with a ~1.2s pause on every URL, which
  // was most of the 42s this connector spent before returning nothing.
  let last = 0;
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 1600).catch(() => {});
    await humanDelay(700, 1200);
    const now = await page.locator('a[href*="/in/"]').count().catch(() => last);
    if (now <= last && i >= 1) break;
    last = now;
  }

  // Preferred path: the classic feed markup, still used on /feed/.
  const classic = await page.evaluate((sel) => {
    const out = [];
    for (const n of document.querySelectorAll(sel)) {
      const urn = n.getAttribute('data-urn') || '';
      const textEl = n.querySelector('.update-components-text, .feed-shared-update-v2__description, span[dir="ltr"]');
      const text = (textEl?.innerText || n.innerText || '').trim();
      if (!text) continue;
      const actorEl = n.querySelector('.update-components-actor__title, .update-components-actor__name');
      const author = (actorEl?.innerText || '').trim().split('\n')[0] || 'LinkedIn member';
      const activityId = (urn.match(/urn:li:activity:(\d+)/) || [])[1] || '';
      out.push({ activityId, urn, author, text: text.slice(0, 3000) });
    }
    return out;
  }, POST_SEL).catch(() => []);
  if (classic.length) return classic;

  return await extractStructural(page);
}

export default {
  id: 'linkedinposts',
  label: 'LinkedIn Posts (hiring)',
  loginUrl: 'https://www.linkedin.com/login',
  requiresAuth: true,
  requiresBrowser: true,

  async scan(ctx, profile) {
    const kws = keywordList(profile);
    const page = await ctx.newPage();
    const out = [];
    let fetchedCount = 0;
    const seen = new Set();

    const urls = [...searchUrls(profile), 'https://www.linkedin.com/feed/'];
    // Content search is members-only. Check the session ONCE up front rather than
    // scrolling three dead pages for 42s and then reporting "source returned nothing",
    // which reads like LinkedIn is down when in fact you are simply logged out.
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const wall = await detectWall(page);
    const loggedIn = !wall && !/\/(login|signup|authwall)/.test(page.url());
    if (!loggedIn) {
      await page.close().catch(() => {});
      throw new Error('LinkedIn Posts needs a signed-in session. Open Sources → LinkedIn → "Open & log in", sign in, leave that window open, then scan again.');
    }

    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await waitForCaptcha(page);
        await humanDelay(1500, 3000);
        const posts = await harvestPosts(page);
        fetchedCount += posts.length;
        for (const p of posts) {
          if (!looksLikeOffer(p.text)) continue;
          if (kws.length && !matchesKeywords(p.text, kws)) continue;
          const ext = p.activityId || p.urn || p.text.slice(0, 60);
          const id = jobId('linkedinposts', String(ext));
          if (seen.has(id)) continue;
          seen.add(id);
          // First line of the post makes the most useful "title".
          const firstLine = p.text.split('\n').map((s) => s.trim()).filter(Boolean)[0] || 'LinkedIn hiring post';
          out.push({
            id,
            external_id: String(ext),
            title: firstLine.slice(0, 160),
            company: p.author,
            location: 'See post',
            url: p.activityId
              ? `https://www.linkedin.com/feed/update/urn:li:activity:${p.activityId}/`
              : (p.profileUrl || 'https://www.linkedin.com/feed/'),
            salary: '',
            posted_at: '',
            description: p.text,
          });
          if (out.length >= 60) break;
        }
      } catch {
        // skip this URL, try the next
      }
      if (out.length >= 60) break;
    }

    await page.close().catch(() => {});
    return withFetched(out, fetchedCount);
  },

  async apply(ctx, profile, job) {
    const page = await ctx.newPage();
    try { await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch { /* opened */ }
    return { status: 'opened', note: 'LinkedIn post opened — follow the instructions in the post (comment / DM / apply link).' };
  },
};
