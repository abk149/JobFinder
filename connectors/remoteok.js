import { jobId, keywordList, matchesKeywords, htmlToText, fetchJson, externalApply, withFetched } from './_util.js';

// RemoteOK exposes a public JSON feed. Note: the first array element is metadata
// (a "legal" notice), not a job — skip anything without an id/position.
export default {
  id: 'remoteok',
  label: 'RemoteOK',
  loginUrl: 'https://remoteok.com/',
  requiresAuth: false,
  requiresBrowser: false,

  async scan(ctx, profile) {
    const kws = keywordList(profile);
    const data = await fetchJson('https://remoteok.com/api');
    const items = Array.isArray(data) ? data : [];
    let fetchedCount = items.length;
    const out = [];
    for (const item of items) {
      if (!item || !item.id || !item.position) continue;
      const haystack = `${item.position} ${item.description || ''} ${(item.tags || []).join(' ')}`;
      if (!matchesKeywords(haystack, kws)) continue;
      out.push({
        id: jobId('remoteok', String(item.id)),
        external_id: String(item.id),
        title: item.position,
        company: item.company || '',
        location: item.location || 'Remote',
        url: item.url || `https://remoteok.com/remote-jobs/${item.id}`,
        salary: item.salary_min ? `$${item.salary_min}-$${item.salary_max || ''}` : '',
        posted_at: item.date || '',
        description: htmlToText(item.description),
      });
      if (out.length >= 60) break;
    }
    return withFetched(out, fetchedCount);
  },

  apply: externalApply('RemoteOK redirects to the employer — complete the application there.'),
};
