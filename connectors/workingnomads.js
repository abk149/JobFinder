import { jobId, keywordList, matchesKeywords, htmlToText, fetchJson, externalApply, withFetched } from './_util.js';

// Working Nomads — remote jobs aggregator with a public JSON feed.
// https://www.workingnomads.com/api/exposed_jobs/
export default {
  id: 'workingnomads',
  label: 'Working Nomads (remote)',
  loginUrl: 'https://www.workingnomads.com/jobs',
  requiresAuth: false,
  requiresBrowser: false,

  async scan(ctx, profile) {
    const kws = keywordList(profile);
    const data = await fetchJson('https://www.workingnomads.com/api/exposed_jobs/');
    const jobs = Array.isArray(data) ? data : (data?.jobs || []);
    const fetchedCount = jobs.length;
    const out = [];
    for (const j of jobs) {
      const ext = j.url || j.slug || j.id;
      if (!j || !j.title || !ext) continue;
      const haystack = `${j.title} ${j.category_name || ''} ${j.tags || ''}`;
      if (!matchesKeywords(haystack, kws)) continue;
      out.push({
        id: jobId('workingnomads', String(ext)),
        external_id: String(ext),
        title: j.title,
        company: j.company_name || '',
        location: j.location || 'Remote',
        url: j.url || '',
        salary: '',
        posted_at: j.pub_date || j.date || '',
        description: htmlToText(j.description),
      });
      if (out.length >= 60) break;
    }
    return withFetched(out, fetchedCount);
  },

  apply: externalApply('Working Nomads redirects to the employer — complete the application there.'),
};
