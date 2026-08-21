import { jobId, keywordList, matchesKeywords, externalApply } from './_util.js';

// Y Combinator's job board (ycombinator.com/jobs — the public face of
// Work at a Startup).
//
// No public JSON API exists: workatastartup.com/companies.json returns 406, and
// yc-oss.github.io publishes companies but not jobs. The site is an Inertia.js app
// though, which server-renders its entire page payload into a `data-page` attribute
// — so a plain fetch gets fully structured job objects with no browser and no
// HTML-scraping guesswork.
//
// The payload is richer than most boards: salary AND equity ranges, minimum
// experience, and visa-sponsorship status all come through.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Role slugs from the board's own filter list. Pulling several gives breadth
// beyond the ~20 postings the unfiltered page returns.
const ROLE_PAGES = [
  '', // the default mixed feed
  '/role/engineering',
  '/role/software-engineer',
  '/role/product-manager',
  '/role/science',
  '/role/operations',
];

/** Fetch a YC jobs page and pull the Inertia payload out of `data-page`. */
async function fetchInertia(pathSuffix) {
  try {
    const r = await fetch(`https://www.ycombinator.com/jobs${pathSuffix}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/data-page="([^"]+)"/);
    if (!m) return null;
    const decoded = m[1]
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&'); // must be last — other entities contain &
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

/** "/companies/camber-2" → "Camber". The payload has no plain company name. */
function companyFromUrl(companyUrl) {
  const slug = String(companyUrl || '').split('/').filter(Boolean).pop() || '';
  return slug
    .replace(/-\d+$/, '')          // YC appends -2, -3 to disambiguate slugs
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export default {
  id: 'ycombinator',
  label: 'Y Combinator (Work at a Startup)',
  loginUrl: 'https://www.workatastartup.com/',
  requiresAuth: false,
  requiresBrowser: false,

  async scan(ctx, profile) {
    const kws = keywordList(profile);
    const out = [];
    const seen = new Set();

    for (const page of ROLE_PAGES) {
      if (out.length >= 100) break;
      const data = await fetchInertia(page);
      const postings = data?.props?.jobPostings || [];
      for (const j of postings) {
        if (!j?.id || !j.title) continue;
        const ext = String(j.id);
        if (seen.has(ext)) continue;

        const company = companyFromUrl(j.companyUrl);
        const haystack = `${j.title} ${j.roleSpecificType || ''} ${j.prettyRole || ''} ${(j.skills || []).join(' ')} ${company}`;
        if (!matchesKeywords(haystack, kws)) continue;
        seen.add(ext);

        // Detail lines the board exposes that most sources don't.
        const detail = [
          j.type,
          j.minExperience ? `${j.minExperience} experience` : '',
          j.equityRange ? `Equity ${j.equityRange}` : '',
          j.visa ? `Visa: ${j.visa}` : '',
          j.roleSpecificType,
        ].filter(Boolean).join(' · ');

        out.push({
          id: jobId('ycombinator', ext),
          external_id: ext,
          title: j.title,
          company,
          location: j.location || 'See posting',
          url: j.url ? `https://www.ycombinator.com${j.url}` : 'https://www.ycombinator.com/jobs',
          salary: j.salaryRange || '',
          posted_at: '',
          description: detail,
        });
        if (out.length >= 100) break;
      }
    }
    return out;
  },

  apply: externalApply('YC posting opened — applying goes through Work at a Startup (you may need a YC account).'),
};
