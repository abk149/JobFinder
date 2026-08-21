import { jobId, keywordList, matchesKeywords, htmlToText, externalApply } from './_util.js';

// We Work Remotely — via their public RSS feeds.
//
// This used to be a browser scraper built on CSS selectors (`li.feature`,
// `span.title`), which meant launching Chrome and breaking every time WWR touched
// its markup. They publish RSS, which is a stable contract: no browser, no
// selectors, ~1s instead of ~15s, and it survives site redesigns.
//
// Feed item shape (non-standard but consistent):
//   <title>Company: Job Title</title>
//   <region>Anywhere in the World</region>
//   <category>Full-Stack Programming</category>
//   <type>Full-Time</type>
//   <description>…HTML-escaped…</description>

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// The main feed plus the category feeds most relevant to this app's users.
// Duplicates across feeds are collapsed by link.
const FEEDS = [
  'https://weworkremotely.com/remote-jobs.rss',
  'https://weworkremotely.com/categories/remote-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',
  'https://weworkremotely.com/categories/remote-product-jobs.rss',
];

function unescapeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&'); // last: other entities can contain &
}

function tag(item, name) {
  const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? unescapeXml(m[1]).trim() : '';
}

async function fetchFeed(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) return [];
    const xml = await r.text();
    return xml.split('<item>').slice(1).map((chunk) => chunk.split('</item>')[0]);
  } catch {
    return [];
  }
}

export default {
  id: 'weworkremotely',
  label: 'We Work Remotely',
  loginUrl: 'https://weworkremotely.com/',
  requiresAuth: false,
  requiresBrowser: false, // RSS — no Chrome needed since moving off the scraper

  async scan(ctx, profile) {
    const kws = keywordList(profile);
    const out = [];
    const seen = new Set();

    for (const feed of FEEDS) {
      if (out.length >= 120) break;
      for (const item of await fetchFeed(feed)) {
        const rawTitle = tag(item, 'title');
        const link = tag(item, 'link');
        if (!rawTitle || !link || seen.has(link)) continue;

        // WWR formats titles as "Company: Role". Split on the FIRST colon only —
        // roles frequently contain their own colons ("Engineer: Platform").
        const idx = rawTitle.indexOf(':');
        const company = idx > 0 ? rawTitle.slice(0, idx).trim() : '';
        const title = idx > 0 ? rawTitle.slice(idx + 1).trim() : rawTitle;

        const category = tag(item, 'category');
        const type = tag(item, 'type');
        const description = htmlToText(tag(item, 'description'), 3000);

        if (!matchesKeywords(`${title} ${company} ${category} ${description}`, kws)) continue;
        seen.add(link);

        out.push({
          id: jobId('weworkremotely', link),
          external_id: link,
          title,
          company,
          location: tag(item, 'region') || 'Remote',
          url: link,
          salary: '',
          posted_at: tag(item, 'pubDate'),
          description: [category, type].filter(Boolean).join(' · ') + (description ? `\n\n${description}` : ''),
        });
        if (out.length >= 120) break;
      }
    }
    return out;
  },

  apply: externalApply('We Work Remotely redirects to the employer — complete the application there.'),
};
