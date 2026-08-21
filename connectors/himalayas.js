import { jobId, keywordList, matchesKeywords, htmlToText, fetchJson, externalApply, withFetched } from './_util.js';

// Himalayas — remote jobs with a public JSON API.
//   https://himalayas.app/jobs/api?limit=20  (limit is capped at 20 per request)
// Note: the free/unauthenticated API redacts a few fields — `companyName` comes back
// as the literal "name" and logo/applicationLink are placeholders. But `companySlug`
// is real, so we derive the company name and a working URL from it.
function titleCase(slug) {
  return String(slug || '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export default {
  id: 'himalayas',
  label: 'Himalayas (remote)',
  loginUrl: 'https://himalayas.app/',
  requiresAuth: false,
  requiresBrowser: false,

  async scan(ctx, profile) {
    const kws = keywordList(profile);
    const data = await fetchJson('https://himalayas.app/jobs/api?limit=20');
    const jobs = data?.jobs || [];
    const fetchedCount = jobs.length;
    const out = [];
    for (const j of jobs) {
      const title = j.title || j.jobTitle;
      const ext = j.guid || j.companySlug || title;
      if (!title || !ext) continue;
      const locs = Array.isArray(j.locationRestrictions) && j.locationRestrictions.length
        ? j.locationRestrictions.join(', ')
        : 'Remote';
      const haystack = `${title} ${(j.categories || []).join(' ')} ${(j.seniority || []).join(' ')}`;
      if (!matchesKeywords(haystack, kws)) continue;

      // companyName is redacted to "name" on the free tier → fall back to the slug.
      const company =
        j.companyName && j.companyName !== 'name' ? j.companyName : titleCase(j.companySlug);
      const salary =
        j.minSalary || j.maxSalary
          ? `${j.currency || ''}${j.minSalary || ''}-${j.maxSalary || ''}`.trim()
          : '';
      const url = j.companySlug ? `https://himalayas.app/companies/${j.companySlug}/jobs` : 'https://himalayas.app/jobs';

      out.push({
        id: jobId('himalayas', String(ext)),
        external_id: String(ext),
        title,
        company,
        location: locs,
        url,
        salary,
        posted_at: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : '',
        description: htmlToText(j.excerpt || j.description),
      });
      if (out.length >= 60) break;
    }
    return withFetched(out, fetchedCount);
  },

  apply: externalApply('Himalayas redirects to the employer — complete the application there.'),
};
