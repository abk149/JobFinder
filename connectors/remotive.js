import { jobId, keywordList, matchesKeywords, htmlToText, fetchJson, externalApply, withFetched } from './_util.js';

// Remotive — large curated remote-jobs board with a clean public JSON API.
// https://remotive.com/api/remote-jobs?search=<terms>
export default {
  id: 'remotive',
  label: 'Remotive (remote)',
  loginUrl: 'https://remotive.com/',
  requiresAuth: false,
  requiresBrowser: false,

  async scan(ctx, profile) {
    const kws = keywordList(profile);
    // NOTE: Remotive's `search` parameter is a no-op — verified by requesting
    // search=product+manager, search=consultant and search=AI+Transformation and
    // getting byte-identical results each time. So we take the full feed and filter
    // locally rather than pretending the server did it.
    const data = await fetchJson('https://remotive.com/api/remote-jobs?limit=100');
    const jobs = data?.jobs || [];
    const fetchedCount = jobs.length;
    const out = [];
    for (const j of jobs) {
      if (!j || !j.id || !j.title) continue;
      // Match against the description too. Title-only matching threw away roles
      // whose body clearly matched — a "Business Development Representative" ad
      // that says "consultant" throughout still never matched "consultant".
      const haystack = `${j.title} ${j.tags?.join(' ') || ''} ${j.category || ''} ${htmlToText(j.description, 3000)}`;
      if (!matchesKeywords(haystack, kws)) continue;
      out.push({
        id: jobId('remotive', String(j.id)),
        external_id: String(j.id),
        title: j.title,
        company: j.company_name || '',
        location: j.candidate_required_location || 'Remote',
        url: j.url || '',
        salary: j.salary || '',
        posted_at: j.publication_date || '',
        description: htmlToText(j.description),
      });
      if (out.length >= 60) break;
    }
    return withFetched(out, fetchedCount);
  },

  apply: externalApply('Remotive redirects to the employer — complete the application there.'),
};
