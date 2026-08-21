import { jobId, keywordList, matchesKeywords, htmlToText, fetchJson, externalApply, withFetched } from './_util.js';

// Jobicy — remote jobs API, no key required.
// https://jobicy.com/api/v2/remote-jobs?count=50&tag=<term>
export default {
  id: 'jobicy',
  label: 'Jobicy (remote)',
  loginUrl: 'https://jobicy.com/',
  requiresAuth: false,
  requiresBrowser: false,

  async scan(ctx, profile) {
    const kws = keywordList(profile);
    const tag = encodeURIComponent((profile.keywords || '').split(',')[0]?.trim() || '');
    const data = await fetchJson(`https://jobicy.com/api/v2/remote-jobs?count=50${tag ? `&tag=${tag}` : ''}`);
    const jobs = data?.jobs || [];
    const fetchedCount = jobs.length;
    const out = [];
    for (const j of jobs) {
      if (!j || !j.id || !j.jobTitle) continue;
      const haystack = `${j.jobTitle} ${j.jobIndustry || ''} ${j.jobType || ''}`;
      if (!matchesKeywords(haystack, kws)) continue;
      const salary =
        j.annualSalaryMin || j.annualSalaryMax
          ? `${j.salaryCurrency || ''}${j.annualSalaryMin || ''}-${j.annualSalaryMax || ''}`.trim()
          : '';
      out.push({
        id: jobId('jobicy', String(j.id)),
        external_id: String(j.id),
        title: j.jobTitle,
        company: j.companyName || '',
        location: j.jobGeo || 'Remote',
        url: j.url || '',
        salary,
        posted_at: j.pubDate || '',
        description: htmlToText(j.jobExcerpt || j.jobDescription),
      });
      if (out.length >= 60) break;
    }
    return withFetched(out, fetchedCount);
  },

  apply: externalApply('Jobicy redirects to the employer — complete the application there.'),
};
