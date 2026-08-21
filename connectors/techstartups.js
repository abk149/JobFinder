import { jobId, keywordList, matchesKeywords, fetchGreenhouseBoard, externalApply, withFetched } from './_util.js';

// Tech Startups — keyless aggregator over the public Greenhouse boards of
// well-known YC / venture-backed companies. Greenhouse exposes the full job list
// at https://boards-api.greenhouse.io/v1/boards/<slug>/jobs with no auth.
//
// To add another company: find its Greenhouse slug (its careers page redirects to
// boards.greenhouse.io/<slug>) and append it to TECH_EMPLOYERS below.
//
// Companies we DON'T include here are on Lever / Ashby / custom ATSes — those
// either have no public API or rate-limit too hard to be reliable in aggregation.
const TECH_EMPLOYERS = [
  // AI / ML
  { slug: 'anthropic',     company: 'Anthropic' },
  { slug: 'huggingface',   company: 'Hugging Face' },
  { slug: 'mistralai',     company: 'Mistral AI' },
  { slug: 'cohere',        company: 'Cohere' },
  { slug: 'characterai',   company: 'Character.AI' },
  // Fintech / Infra
  { slug: 'stripe',        company: 'Stripe' },
  { slug: 'mercury',       company: 'Mercury' },
  { slug: 'plaid',         company: 'Plaid' },
  { slug: 'ramp',          company: 'Ramp' },
  { slug: 'brex',          company: 'Brex' },
  // Developer tools
  { slug: 'figma',         company: 'Figma' },
  { slug: 'airtable',      company: 'Airtable' },
  { slug: 'asana',         company: 'Asana' },
  { slug: 'gitlab',        company: 'GitLab' },
  { slug: 'sentry',        company: 'Sentry' },
  { slug: 'pulumi',        company: 'Pulumi' },
  { slug: 'databricks',    company: 'Databricks' },
  // Consumer / Marketplaces
  { slug: 'doordash',      company: 'DoorDash' },
  { slug: 'instacart',     company: 'Instacart' },
  { slug: 'duolingo',      company: 'Duolingo' },
  { slug: 'discord',       company: 'Discord' },
  { slug: 'reddit',        company: 'Reddit' },
];

const MAX_PER_BOARD = 25; // cap so one giant board doesn't drown out the rest
const MAX_TOTAL = 120;

export default {
  id: 'techstartups',
  label: 'Tech Startups (Greenhouse)',
  loginUrl: 'https://boards.greenhouse.io/',
  requiresAuth: false,
  requiresBrowser: false,

  async scan(ctx, profile) {
    const kws = keywordList(profile);
    // Pull all boards in parallel — they're independent HTTP GETs.
    const boards = await Promise.all(
      TECH_EMPLOYERS.map(async (e) => ({
        employer: e,
        jobs: await fetchGreenhouseBoard(e.slug).catch(() => []),
      }))
    );

    const out = [];
    const fetchedCount = boards.reduce((n, b) => n + b.jobs.length, 0);
    const seen = new Set();
    for (const { employer, jobs } of boards) {
      let kept = 0;
      for (const j of jobs) {
        if (!j.title || !j.id) continue;
        if (!matchesKeywords(`${j.title} ${j.location}`, kws)) continue;
        const id = jobId('techstartups', `${employer.slug}-${j.id}`);
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
        kept++;
        if (kept >= MAX_PER_BOARD) break;
        if (out.length >= MAX_TOTAL) break;
      }
      if (out.length >= MAX_TOTAL) break;
    }
    return withFetched(out, fetchedCount);
  },

  apply: externalApply('Greenhouse application opened — complete it on the employer site.'),
};
