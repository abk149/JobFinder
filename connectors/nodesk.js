import {
  jobId, keywordList, matchesKeywords, htmlToText, externalApply, withFetched,
  fetchFeedItems, feedTag, feedLink,
} from './_util.js';

// NoDesk — curated remote roles, published as an Atom-ish feed at /remote-jobs/index.xml.
//
// Titles arrive as "Senior Manager, Marketing at Framework", so the company is split off
// the tail. Verified live: 10 current items, dated within days.
const FEED = 'https://nodesk.co/remote-jobs/index.xml';

function splitTitle(raw) {
  // Split on the LAST " at ", so "Manager, Data at Acme at Scale" keeps the right half.
  const i = raw.lastIndexOf(' at ');
  if (i === -1) return { title: raw, company: '' };
  return { title: raw.slice(0, i).trim(), company: raw.slice(i + 4).trim() };
}

export default {
  id: 'nodesk',
  label: 'NoDesk',
  loginUrl: 'https://nodesk.co/remote-jobs/',
  requiresAuth: false,
  requiresBrowser: false,

  async scan(ctx, profile) {
    const kws = keywordList(profile);
    const items = await fetchFeedItems(FEED);
    const out = [];

    for (const item of items) {
      const raw = feedTag(item, 'title');
      const url = feedLink(item);
      if (!raw || !url) continue;

      const { title, company } = splitTitle(raw);
      const description = htmlToText(
        feedTag(item, 'content:encoded') || feedTag(item, 'summary') || feedTag(item, 'description'),
        2500
      );
      if (!matchesKeywords(`${title} ${company} ${description}`, kws)) continue;

      const ext = url.split('?')[0];
      out.push({
        id: jobId('nodesk', ext),
        external_id: ext,
        title: title.slice(0, 160),
        company: company || 'NoDesk',
        location: 'Remote',
        url,
        salary: '',
        posted_at: feedTag(item, 'pubDate') || feedTag(item, 'updated') || '',
        description,
      });
    }
    return withFetched(out, items.length);
  },

  apply: externalApply('NoDesk listing opened — apply on the employer’s own page.'),
};
