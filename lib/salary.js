// Salary intelligence and negotiation prep.
//
// Most "salary data" tools are guesses dressed up as numbers. This one leads with
// something better: the salary ranges published in the job ads YOU have already
// scraped. That's real, current, role-and-market-specific data sitting unused in
// your own database — hundreds of postings, many of which state a band (EU ads
// especially, where disclosure is increasingly mandatory).
//
// Where that data is thin we say so rather than inventing a number. An invented
// benchmark is worse than none: it anchors you wrong in the one conversation where
// being wrong is expensive.

import { all } from './db.js';
import { chat } from './llm.js';
import { normalizeTitle } from './fit.js';

// Currency symbols/codes → a canonical label.
const CURRENCIES = [
  { re: /€|\beur\b/i, code: 'EUR' },
  { re: /£|\bgbp\b/i, code: 'GBP' },
  { re: /\$|\busd\b/i, code: 'USD' },
  { re: /₹|\binr\b|\blpa\b/i, code: 'INR' },
  { re: /\bchf\b/i, code: 'CHF' },
];

/**
 * Parse a free-text salary string into a normalised annual range.
 * Handles "€70,000 - €95,000", "$120k-$150k", "90-110k EUR", "12 LPA".
 * Returns null when nothing numeric and plausible is present.
 */
export function parseSalary(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 120) return null;

  const cur = CURRENCIES.find((c) => c.re.test(s))?.code || null;

  // Pull numbers, honouring a trailing k/K multiplier per number.
  const parsedNums = [];
  for (const m of s.matchAll(/(\d[\d.,]*)\s*([kK])?/g)) {
    const rawNum = m[1].replace(/,/g, '');
    if (!rawNum || rawNum === '.') continue;
    const n = parseFloat(rawNum);
    if (!isFinite(n)) continue;
    parsedNums.push({ value: n, hadK: !!m[2] });
  }
  if (!parsedNums.length) return null;

  // In a range like "90-110k" the multiplier is written once but applies to both
  // ends. Without this, 90 stays 90, fails the plausibility floor, and the range
  // silently collapses to a single number.
  const anyK = parsedNums.some((p) => p.hadK);
  let nums = parsedNums.map((p) => (p.hadK || (anyK && p.value < 1000) ? p.value * 1000 : p.value));

  // "12 LPA" / "₹18-25 LPA" — Indian lakhs per annum.
  const isLpa = /\blpa\b|lakh/i.test(s);
  if (isLpa) nums = parsedNums.map((p) => p.value * 100000);

  // Monthly figures happen in EU ads ("€6,500 / month").
  const perMonth = /per month|\/ ?month|monthly|p\.m\.|pm\b/i.test(s);
  const annual = perMonth ? nums.map((n) => n * 12) : nums;

  // Plausibility bounds must be currency-aware: 25 LPA is ₹2,500,000, which a
  // one-size ceiling of 1,000,000 would throw away as implausible.
  const currency = cur || (isLpa ? 'INR' : null);
  const [floor, ceil] = currency === 'INR' ? [100000, 100000000] : [15000, 2000000];

  const plausible = annual.filter((n) => n >= floor && n <= ceil);
  if (!plausible.length) return null;

  const min = Math.min(...plausible);
  const max = Math.max(...plausible);
  return { min, max, mid: Math.round((min + max) / 2), currency };
}

function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

/**
 * Build a salary picture for a role from the user's own scraped postings.
 *
 * @returns { sample, currency, range, comparable[], note }
 */
export async function marketRange(profileId, job) {
  const rows = await all(
    `SELECT title, company, location, salary FROM jobs
      WHERE profile_id = ? AND salary IS NOT NULL AND salary != ''`,
    [profileId]
  );

  const target = normalizeTitle(job?.title || '');
  const targetWords = target.split(' ').filter((w) => w.length > 3);

  const parsed = [];
  for (const r of rows) {
    const p = parseSalary(r.salary);
    if (!p) continue;
    const t = normalizeTitle(r.title);
    // Relevance: share the title's distinctive words with the target role.
    const overlap = targetWords.length
      ? targetWords.filter((w) => t.includes(w)).length / targetWords.length
      : 0;
    parsed.push({ ...p, title: r.title, company: r.company, location: r.location, raw: r.salary, overlap });
  }

  const comparable = parsed.filter((p) => p.overlap >= 0.5);
  const pool = comparable.length >= 3 ? comparable : parsed;

  if (!pool.length) {
    return {
      sample: 0, currency: null, range: null, comparable: [],
      note: 'None of your scraped postings list a salary, so there is no local data to work from. Treat any figure below as unverified.',
    };
  }

  // Report in whichever currency dominates the sample; mixing them is meaningless.
  const byCur = {};
  for (const p of pool) { const c = p.currency || 'unknown'; (byCur[c] ||= []).push(p); }
  const [currency, group] = Object.entries(byCur).sort((a, b) => b[1].length - a[1].length)[0];

  return {
    sample: group.length,
    currency: currency === 'unknown' ? null : currency,
    range: {
      low: Math.min(...group.map((p) => p.min)),
      median: median(group.map((p) => p.mid)),
      high: Math.max(...group.map((p) => p.max)),
    },
    comparable: group
      .sort((a, b) => b.overlap - a.overlap || b.mid - a.mid)
      .slice(0, 8)
      .map((p) => ({ title: p.title, company: p.company, salary: p.raw, location: p.location })),
    exact: comparable.length >= 3,
    note: comparable.length >= 3
      ? `Based on ${group.length} of your scraped postings for comparable roles.`
      : `Only ${comparable.length} closely-comparable postings, so this widens to ${group.length} postings across your saved jobs — treat it as a rough band.`,
  };
}

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.search(/[[{]/);
  if (start === -1) return null;
  const open = t[start]; const close = open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === open) depth++;
    else if (t[i] === close) { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/** Negotiation coaching grounded in the market data above. */
export async function negotiationBrief(profile, job, market) {
  const money = market.range
    ? `${market.currency || ''} ${market.range.low.toLocaleString()} – ${market.range.high.toLocaleString()} (median ~${market.range.median?.toLocaleString()}), from ${market.sample} postings`
    : 'no local salary data available';

  const system = [
    'You are an experienced negotiation coach advising a candidate on compensation.',
    'Be concrete and tactical. Give scripts they can actually say, not principles.',
    'Ground anchors in the market data supplied. If the data is weak, say so and advise how to get a real number (ask the recruiter for the band early — in many places they must tell you).',
    'Never invent salary figures beyond what the data supports.',
    '',
    'Respond with ONLY a JSON object:',
    '{"anchor":"what number or band to state and why","script":"a short thing to say verbatim when asked for expectations","levers":["non-salary items worth trading for"],"mistakes":["2-3 specific errors to avoid in this situation"],"when_asked_first":"exactly what to say if they ask your expectations before making an offer"}',
  ].join('\n');

  let bio = '';
  try {
    const f = typeof profile.filters === 'string' ? JSON.parse(profile.filters) : profile.filters || {};
    bio = f.bio || '';
  } catch { /* ignore */ }

  const raw = await chat(profile, [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        `ROLE: ${job?.title || ''}${job?.company ? ' at ' + job.company : ''}`,
        `LOCATION: ${job?.location || 'unspecified'}`,
        `POSTED SALARY: ${job?.salary || '(not stated)'}`,
        `MARKET DATA FROM THE CANDIDATE'S OWN SCRAPED POSTINGS: ${money}`,
        bio ? `CANDIDATE: ${bio}` : '',
      ].filter(Boolean).join('\n'),
    },
  ], { num_predict: 1400, temperature: 0.4, json: true, useSynthModel: true });

  return extractJson(raw);
}
