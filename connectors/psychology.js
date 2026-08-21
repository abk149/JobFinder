import { jobId, keywordList, matchesKeywords, fetchGreenhouseBoard, externalApply, withFetched } from './_util.js';

// Psychology / mental-health roles. The general remote boards carry almost none, so
// this connector pulls directly from the public Greenhouse job boards of dedicated
// mental-health employers (keyless API), then keeps the psychology-relevant postings.
// No login, no browser.
//
// To add another employer: find its Greenhouse board slug (its careers page will load
// boards.greenhouse.io/<slug>) and add it to MENTAL_HEALTH_EMPLOYERS below.
const MENTAL_HEALTH_EMPLOYERS = [
  { slug: 'twochairs', company: 'Two Chairs' },
  { slug: 'headway', company: 'Headway' },
  { slug: 'cerebral', company: 'Cerebral' },
  { slug: 'talkspace', company: 'Talkspace' },
  { slug: 'modernhealth', company: 'Modern Health' },
  { slug: 'alma', company: 'Alma' },
];

// On these dedicated mental-health boards, "Therapist" / "Clinician" ARE psych roles,
// so we accept them here (unlike the general healthcare feeds where they'd be PT/OT).
const PSYCH_RX =
  /psycholog|psychotherap|psychiatr|therapist|counsel|mental health|behavioral health|behavioural health|clinician|neuropsych|\b(lcsw|lmft|lpc|lpcc|lmhc|psyd|cmhc)\b/i;

export default {
  id: 'psychology',
  label: 'Psychology & Mental Health',
  loginUrl: 'https://www.greenhouse.io/',
  requiresAuth: false,
  requiresBrowser: false,

  async scan(ctx, profile) {
    const kws = keywordList(profile);
    const boards = await Promise.all(
      MENTAL_HEALTH_EMPLOYERS.map(async (e) => ({
        employer: e,
        jobs: await fetchGreenhouseBoard(e.slug).catch(() => []),
      }))
    );

    const out = [];
    const fetchedCount = boards.reduce((n, b) => n + b.jobs.length, 0);
    const seen = new Set();
    for (const { employer, jobs } of boards) {
      for (const j of jobs) {
        if (!j.title || !j.id) continue;
        if (!PSYCH_RX.test(j.title)) continue;
        if (!matchesKeywords(`${j.title} ${j.location}`, kws)) continue;
        const id = jobId('psychology', `${employer.slug}-${j.id}`);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          external_id: `${employer.slug}-${j.id}`,
          title: j.title,
          company: employer.company,
          location: j.location,
          url: j.url,
          salary: '',
          posted_at: j.posted_at,
          description: '',
        });
        if (out.length >= 100) break;
      }
    }
    return withFetched(out, fetchedCount);
  },

  apply: externalApply('Opened the employer posting — complete the application there.'),
};
