import { jobId, keywordList, matchesKeywords, htmlToText, fetchJson, firstLocation, externalApply } from './_util.js';

// The Muse — public jobs API (no key needed for basic use).
// https://www.themuse.com/api/public/jobs?page=0
export default {
  id: 'themuse',
  label: 'The Muse',
  loginUrl: 'https://www.themuse.com/',
  requiresAuth: false,
  requiresBrowser: false,

  async scan(ctx, profile) {
    const kws = keywordList(profile);
    const loc = firstLocation(profile);
    const locParam = loc ? `&location=${encodeURIComponent(loc)}` : '';
    const out = [];
    for (let pageNum = 0; pageNum <= 2 && out.length < 60; pageNum++) {
      const data = await fetchJson(`https://www.themuse.com/api/public/jobs?page=${pageNum}${locParam}`);
      const results = data?.results || [];
      if (!results.length) break;
      for (const j of results) {
        if (!j || !j.id || !j.name) continue;
        const cats = (j.categories || []).map((c) => c.name).join(' ');
        const levels = (j.levels || []).map((l) => l.name).join(' ');
        if (!matchesKeywords(`${j.name} ${cats} ${levels}`, kws)) continue;
        const locations = (j.locations || []).map((l) => l.name).join(', ');
        out.push({
          id: jobId('themuse', String(j.id)),
          external_id: String(j.id),
          title: j.name,
          company: j.company?.name || '',
          location: locations || 'Flexible',
          url: j.refs?.landing_page || '',
          salary: '',
          posted_at: j.publication_date || '',
          description: htmlToText(j.contents),
        });
        if (out.length >= 60) break;
      }
    }
    return out;
  },

  apply: externalApply('The Muse redirects to the employer — complete the application there.'),
};
