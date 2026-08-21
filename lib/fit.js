// Fit scoring — turns an undifferentiated pile of scraped jobs into a ranked
// shortlist, with a defensible reason attached to every score.
//
// Design principles:
//   • DETERMINISTIC. No LLM. Scoring hundreds of jobs with a local 8B model would
//     take hours and give unstable results; this runs over 347 jobs in well under a
//     second and gives the same answer every time.
//   • EXPLAINABLE. Every score comes with the requirements you meet and the ones you
//     miss. A number you can't interrogate is worse than no number.
//   • HONEST ABOUT UNKNOWNS. If we can't read your CV we say the score is low
//     confidence rather than quietly pretending.
//
// Score is 0-100, weighted:
//   55  skills      — how many of the JD's required skills you demonstrably have
//   20  seniority   — does the job's level match yours (over- and under-shooting both hurt)
//   15  location    — remote / your stated locations
//   10  freshness   — recent postings are far more likely to reply

import { matchSkillsInText } from './prep/skills.js';
import { parseFilters } from './profileSettings.js';
import { htmlToText } from '../connectors/_util.js';

const W = { skills: 55, seniority: 20, location: 15, freshness: 10 };

// ── Seniority ───────────────────────────────────────────────────────────────
// Ordered ladder; distance between rungs drives the penalty.
const LEVELS = [
  { name: 'intern',    rank: 0, re: /\b(intern|internship|working student|werkstudent|praktikum)\b/i },
  { name: 'junior',    rank: 1, re: /\b(junior|entry[- ]level|graduate|jr\.?|associate)\b/i },
  { name: 'mid',       rank: 2, re: /\b(mid[- ]level|intermediate)\b/i },
  { name: 'senior',    rank: 3, re: /\b(senior|sr\.?|erfahren)\b/i },
  { name: 'staff',     rank: 4, re: /\b(staff|lead engineer|principal|architect|team lead|teamlead|tech lead)\b/i },
  // "Head of X" belongs here rather than in staff — otherwise "Head of Engineering"
  // and "Head of Machine Learning" classify differently, which is indefensible.
  { name: 'executive', rank: 5, re: /\b(director|vp|vice president|chief|cto|ceo|head of)\b/i },
];

export function detectLevel(text) {
  const t = String(text || '');
  // Scan highest-first so "Senior Staff Engineer" reads as staff, not senior.
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (LEVELS[i].re.test(t)) return LEVELS[i];
  }
  return null;
}

// ── Candidate profile → the skills we can prove they have ───────────────────

/**
 * Everything we know the candidate can do, from three sources:
 *   CV text (richest), profile keywords, and their saved application answers.
 */
export function candidateSkillProfile(profile, answers = []) {
  const filters = parseFilters(profile);
  const cvText = filters.cv_text || '';
  const answerText = answers.map((a) => `${a.label || a.field_key}: ${a.value}`).join('\n');
  const combined = [cvText, filters.bio || '', profile.keywords || '', answerText].filter(Boolean).join('\n');

  const skills = new Set(matchSkillsInText(combined).map((s) => s.skill));
  return {
    skills,
    level: detectLevel(`${profile.keywords || ''} ${filters.bio || ''} ${cvText.slice(0, 1500)}`),
    locations: (profile.locations || '')
      .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
    hasCv: cvText.length > 200,
    sources: {
      cv: cvText.length > 200,
      bio: !!(filters.bio || '').trim(),
      keywords: !!(profile.keywords || '').trim(),
      answers: answers.length,
    },
  };
}

// ── Scoring one job ─────────────────────────────────────────────────────────

function scoreLocation(job, cand) {
  const loc = `${job.location || ''}`.toLowerCase();
  if (!loc) return { pts: W.location * 0.6, note: 'location not stated' };
  if (/remote|anywhere|worldwide|home office/.test(loc)) {
    return { pts: W.location, note: 'remote' };
  }
  if (!cand.locations.length) return { pts: W.location * 0.6, note: 'no location preference set' };
  for (const want of cand.locations) {
    if (!want) continue;
    if (loc.includes(want) || want.includes(loc)) return { pts: W.location, note: `matches "${want}"` };
    if (/remote/.test(want)) return { pts: W.location * 0.5, note: 'you want remote; this is on-site' };
  }
  return { pts: 0, note: `${job.location} is outside your locations` };
}

function scoreFreshness(job) {
  const ts = Number(job.posted_at ? Date.parse(job.posted_at) : NaN) || job.discovered_at || 0;
  if (!ts) return { pts: W.freshness * 0.5, days: null };
  const days = Math.max(0, Math.floor((Date.now() - ts) / 86400000));
  // Full marks under a week, decaying to zero at ~60 days.
  const pts = days <= 7 ? W.freshness : Math.max(0, W.freshness * (1 - (days - 7) / 53));
  return { pts, days };
}

function scoreSeniority(jobLevel, candLevel) {
  if (!jobLevel) return { pts: W.seniority * 0.65, note: 'level not stated' };
  if (!candLevel) return { pts: W.seniority * 0.65, note: 'your level unknown — add a CV or bio' };
  const gap = jobLevel.rank - candLevel.rank;
  if (gap === 0) return { pts: W.seniority, note: `${jobLevel.name} — matches your level` };
  if (gap === 1) return { pts: W.seniority * 0.7, note: `${jobLevel.name} — a step up (a stretch, worth trying)` };
  if (gap === -1) return { pts: W.seniority * 0.55, note: `${jobLevel.name} — a step down` };
  if (gap > 1) return { pts: W.seniority * 0.2, note: `${jobLevel.name} — ${gap} levels above you` };
  return { pts: W.seniority * 0.25, note: `${jobLevel.name} — ${-gap} levels below you` };
}

/**
 * Score one job against the candidate.
 * @returns { score, band, matched[], missing[], reasons[], confidence }
 */
export function scoreJob(job, cand) {
  const jd = htmlToText(job.description || '', 9000);
  const jdSkills = matchSkillsInText(jd, { withEvidence: false }).map((s) => s.skill);
  // Titles carry real signal and are often the only text on API-sourced jobs.
  const titleSkills = matchSkillsInText(`${job.title || ''} ${job.company || ''}`).map((s) => s.skill);
  const required = [...new Set([...jdSkills, ...titleSkills])];

  const matched = required.filter((s) => cand.skills.has(s));
  const missing = required.filter((s) => !cand.skills.has(s));

  // Skills component. With no detectable requirements we can't judge, so award a
  // neutral score rather than punishing a job for a thin description.
  let skillPts;
  let skillNote;
  if (!required.length) {
    skillPts = W.skills * 0.5;
    skillNote = 'no recognisable skills in this posting — score is a guess';
  } else {
    const ratio = matched.length / required.length;
    skillPts = W.skills * ratio;
    skillNote = `${matched.length}/${required.length} required skills`;
  }

  const jobLevel = detectLevel(`${job.title || ''} ${jd.slice(0, 600)}`);
  const sen = scoreSeniority(jobLevel, cand.level);
  const loc = scoreLocation(job, cand);
  const fresh = scoreFreshness(job);

  const score = Math.round(skillPts + sen.pts + loc.pts + fresh.pts);

  const reasons = [
    skillNote,
    sen.note,
    loc.note,
    fresh.days === null ? 'age unknown' : fresh.days <= 7 ? 'posted this week' : `posted ~${fresh.days} days ago`,
  ];

  // Confidence is about how much we actually knew, separate from the score itself.
  let confidence = 'high';
  if (!cand.hasCv) confidence = 'low';
  else if (!required.length) confidence = 'low';
  else if (required.length < 3) confidence = 'medium';

  return {
    score: Math.max(0, Math.min(100, score)),
    band: score >= 70 ? 'strong' : score >= 50 ? 'possible' : 'weak',
    matched,
    missing,
    reasons,
    confidence,
    jobLevel: jobLevel?.name || null,
    requiredCount: required.length,
  };
}

/** Score many jobs. Pure CPU, no network — safe to run over the whole table. */
export function scoreAll(jobs, cand) {
  return jobs.map((job) => ({ job, fit: scoreJob(job, cand) }));
}

// ── Cross-connector de-duplication ──────────────────────────────────────────

const COMPANY_NOISE = /\b(gmbh|ag|inc|inc\.|llc|ltd|ltd\.|limited|plc|bv|nv|sa|se|corp|corporation|co|company|group|holding|technologies|technology|labs|software)\b/g;

/** Normalise a company name so "Acme GmbH" and "Acme, Inc." collapse together. */
export function normalizeCompany(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.,()]/g, ' ')
    .replace(COMPANY_NOISE, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/** Normalise a job title: strip location suffixes, gendered markers, req IDs. */
export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\(m\/w\/d\)|\(m\/f\/d\)|\(w\/m\/d\)|\(all genders?\)|\(f\/m\/x\)/g, ' ')
    .replace(/\b(remote|hybrid|onsite|on-site|full[- ]time|part[- ]time|permanent|contract)\b/g, ' ')
    .replace(/[-–—|,/].*$/, ' ')     // drop trailing "— Berlin" / "| Engineering"
    .replace(/\b(req|job|id)[ #-]*\d+\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stable key identifying "the same job" regardless of which board it came from.
 * Empty string when there isn't enough signal to be safe — callers must then treat
 * the row as unique rather than risk merging two genuinely different jobs.
 */
export function canonicalJobKey(job) {
  const c = normalizeCompany(job.company);
  const t = normalizeTitle(job.title);
  if (!c || !t || t.length < 4) return '';
  return `${c}::${t}`;
}
