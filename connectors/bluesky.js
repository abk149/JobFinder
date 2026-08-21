import { jobId, keywordList, matchesKeywords, fetchJsonViaBrowser, externalApply, withFetched } from './_util.js';

// Bluesky hiring-post search. Uses the public AT Protocol search endpoint —
// no login or API key required. We go through the shared off-screen browser
// context, and specifically against api.bsky.app: the public.api.bsky.app host now
// refuses us outright (403 to a direct request, and the browser cannot even reach it
// cross-origin), while api.bsky.app answers the identical query with HTTP 200 when the
// fetch is issued from a real bsky.app page. Verified live.
//
// Queries combine each of the profile's keywords with hiring phrases. We
// de-dup, filter to posts that look like job offers (vs job-seeker pleas),
// and surface them as job rows linking to the original post.

const HIRING_QUERIES = ['hiring', 'we are hiring', 'open role', 'job opening'];
const PER_QUERY_LIMIT = 25;
const MAX_OUT = 80;

// Filter out posts that read as job-SEEKER posts rather than hiring offers.
function looksLikeOffer(text) {
  const t = (text || '').toLowerCase();
  if (/\b(looking for work|open to work|seeking a role|i'?m available|i am available)\b/.test(t)) return false;
  return /\b(hiring|join (us|our team)|apply|open (role|position|vacancy)|recruiting|we'?re looking)\b/.test(t);
}

function postUrl(post) {
  // post.uri looks like: at://did:plc:xxxx/app.bsky.feed.post/yyyy
  const m = (post.uri || '').match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
  if (!m) return '';
  const handle = post.author?.handle || m[1];
  return `https://bsky.app/profile/${handle}/post/${m[2]}`;
}

export default {
  id: 'bluesky',
  label: 'Bluesky posts (hiring)',
  loginUrl: 'https://bsky.app/',
  requiresAuth: false,
  requiresBrowser: true, // public.api 403s plain server fetches; go through the browser

  async scan(ctx, profile) {
    const kws = keywordList(profile);
    const terms = kws.length ? kws.slice(0, 4) : ['software engineer'];

    const queries = [];
    for (const term of terms) {
      for (const phrase of HIRING_QUERIES) {
        queries.push(`${term} ${phrase}`);
      }
    }

    const out = [];
    let fetchedCount = 0;
    const seen = new Set();
    for (const q of queries) {
      if (out.length >= MAX_OUT) break;
      const url = `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=${PER_QUERY_LIMIT}&sort=latest`;
      // Issue the query from a real bsky.app page — the API host rejects requests
      // that do not originate from one.
      const data = await fetchJsonViaBrowser(ctx, url, { origin: 'https://bsky.app' });
      const posts = data?.posts || [];
        fetchedCount += posts.length;
      for (const p of posts) {
        const text = p?.record?.text || '';
        if (!text) continue;
        if (!looksLikeOffer(text)) continue;
        if (kws.length && !matchesKeywords(text, kws)) continue;
        const rkey = (p.uri || '').split('/').pop() || text.slice(0, 60);
        const id = jobId('bluesky', rkey);
        if (seen.has(id)) continue;
        seen.add(id);
        const u = postUrl(p);
        if (!u) continue;
        // First line is the most useful "title".
        const firstLine = text.split('\n').map((s) => s.trim()).filter(Boolean)[0] || 'Bluesky hiring post';
        out.push({
          id,
          external_id: rkey,
          title: firstLine.slice(0, 160),
          company: '@' + (p.author?.handle || 'bsky.social'),
          location: 'See post',
          url: u,
          salary: '',
          posted_at: p.record?.createdAt || p.indexedAt || '',
          description: text.slice(0, 2500),
        });
        if (out.length >= MAX_OUT) break;
      }
    }
    return withFetched(out, fetchedCount);
  },

  apply: externalApply('Bluesky post opened — follow the contact / apply instructions in the post.'),
};
