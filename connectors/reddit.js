import { jobId, keywordList, matchesKeywords, htmlToText, fetchJsonViaBrowser, externalApply, withFetched } from './_util.js';

// Reddit hiring communities. Reddit's public `.json` endpoints return 403 to plain
// server/datacenter requests but serve fine through a real browser session, so this
// connector runs through the stealth browser context (requiresBrowser: true).
//
// We pull "new" posts from the well-known hiring subreddits and keep only the ones
// that look like an offer (hiring side), filtered by the profile's keywords.
const SUBREDDITS = ['forhire', 'jobbit', 'remotejs', 'jobopenings', 'hiring'];

// On r/forhire posts are tagged [Hiring] or [For Hire]; we only want [Hiring].
// Other subs don't always use flair, so we also sniff the title.
function isHiring(post) {
  const flair = (post.link_flair_text || '').toLowerCase();
  const title = (post.title || '').toLowerCase();
  if (flair.includes('for hire') || title.includes('[for hire]')) return false; // job-seeker, skip
  if (flair.includes('hiring')) return true;
  if (/\bhiring\b|\bwe.?re hiring\b|\[hiring\]/.test(title)) return true;
  // jobbit / remotejs are hiring-only boards → accept by default
  return true;
}

export default {
  id: 'reddit',
  label: 'Reddit (r/forhire, r/jobbit…)',
  loginUrl: 'https://www.reddit.com/',
  requiresAuth: false,
  requiresBrowser: true, // Reddit 403s plain server fetches; go through the browser

  async scan(ctx, profile) {
    const kws = keywordList(profile);
    const out = [];
    let fetchedCount = 0;
    // All five subreddits share one origin, so hold a single page open across them.
    // The helper skips the navigation when it is already on the right origin, which
    // turns five page loads into one.
    const page = await ctx.newPage();
    try {
    for (const sub of SUBREDDITS) {
      const data = await fetchJsonViaBrowser(ctx, `https://www.reddit.com/r/${sub}/new.json?limit=50`, { page });
      const posts = data?.data?.children || [];
        fetchedCount += posts.length;
      for (const wrap of posts) {
        const p = wrap?.data;
        if (!p || !p.id || !p.title) continue;
        if (!isHiring(p)) continue;
        const body = `${p.title} ${p.selftext || ''}`;
        if (!matchesKeywords(body, kws)) continue;
        out.push({
          id: jobId('reddit', p.id),
          external_id: p.id,
          title: p.title.replace(/\[hiring\]/i, '').trim().slice(0, 160),
          company: p.author ? `u/${p.author}` : 'Reddit',
          location: p.link_flair_text || 'See post',
          url: `https://www.reddit.com${p.permalink}`,
          salary: '',
          posted_at: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : '',
          description: htmlToText(p.selftext, 2500),
        });
        if (out.length >= 80) break;
      }
      if (out.length >= 80) break;
    }
    } finally {
      await page.close().catch(() => {});
    }
    return withFetched(out, fetchedCount);
  },

  apply: externalApply('Reddit post opened — follow the contact / application instructions in the post.'),
};
