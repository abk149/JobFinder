import { jobId, keywordList, matchesKeywords, htmlToText, fetchJson, externalApply } from './_util.js';

// Hacker News "Ask HN: Who is hiring?" — the monthly mega-thread, mined via the
// Algolia HN API. Each top-level comment is one company's posting. No login, no key.
//   1. find the most recent "Who is hiring?" story by user `whoishiring`
//   2. pull its comments and treat each as a job entry
export default {
  id: 'hackernews',
  label: 'HN: Who is Hiring',
  loginUrl: 'https://news.ycombinator.com/',
  requiresAuth: false,
  requiresBrowser: false,

  async scan(ctx, profile) {
    const kws = keywordList(profile);

    // Latest "Who is hiring?" thread (posted monthly by the whoishiring account).
    const search = await fetchJson(
      'https://hn.algolia.com/api/v1/search_by_date?query=Ask%20HN%3A%20Who%20is%20hiring&tags=story,author_whoishiring&hitsPerPage=1'
    );
    const story = search?.hits?.[0];
    if (!story?.objectID) return [];

    const item = await fetchJson(`https://hn.algolia.com/api/v1/items/${story.objectID}`);
    const comments = item?.children || [];
    const out = [];
    for (const c of comments) {
      if (!c || !c.text || !c.id) continue;
      const text = htmlToText(c.text, 2500);
      if (!text) continue;
      if (!matchesKeywords(text, kws)) continue;
      // First line/segment is conventionally "Company | Role | Location | ...".
      const firstLine = text.split(/[|\n.]/)[0].trim().slice(0, 140);
      out.push({
        id: jobId('hackernews', String(c.id)),
        external_id: String(c.id),
        title: firstLine || 'HN hiring post',
        company: (firstLine.split('|')[0] || '').trim(),
        location: 'See post',
        url: `https://news.ycombinator.com/item?id=${c.id}`,
        salary: '',
        posted_at: c.created_at || '',
        description: text,
      });
      if (out.length >= 80) break;
    }
    return out;
  },

  apply: externalApply('HN post opened — follow the application instructions in the post.'),
};
