// Cover letters: a reusable base on the profile, and a tailored one per job.
//
// Two things make a cover letter land, and both are why this is not just a template:
//   1. It names something specific about THIS company/role that a generic letter can't.
//   2. It maps the candidate's actual evidence onto the posting's actual requirements.
//
// So the tailored version reads the job description and the CV, and is told in the
// strongest terms not to invent employers, dates, numbers or titles — the fastest way
// to lose an offer is a letter that contradicts the CV.
//
// The base template supports placeholders so it stays useful with no LLM at all:
//   {{company}} {{role}} {{location}} {{name}} {{email}} {{phone}} {{source}}

import { get, run } from './db.js';
import { chat } from './llm.js';
import { rankVariantsForJob } from './cvVariants.js';
import { linfo, lok, lwarn } from './logger.js';

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/gi;

/** Fill {{placeholders}} from the job + profile. Unknown ones are left visible on
 *  purpose — a stray {{company}} in a draft is far better than a silent blank. */
export function renderTemplate(template, { job, profile } = {}) {
  if (!template) return '';
  let filters = {};
  try { filters = JSON.parse(profile?.filters || '{}'); } catch { /* ignore */ }
  const map = {
    company: job?.company || '',
    role: job?.title || '',
    location: job?.location || (filters.locations || [])[0] || '',
    name: profile?.name || '',
    email: profile?.email || '',
    phone: filters.phone || '',
    source: job?.connector || '',
  };
  return template.replace(PLACEHOLDER, (m, key) => {
    const v = map[String(key).toLowerCase()];
    return v || m;
  });
}

/**
 * Produce a tailored letter for one job. Cached on the job row, so re-filling a second
 * form for the same posting costs nothing.
 *
 * @param {'auto'|'regenerate'} mode  'auto' returns the cached letter when present.
 */
export async function coverLetterFor(profile, job, { mode = 'auto', words = 220 } = {}) {
  if (mode === 'auto' && job?.cover_letter) {
    return { text: job.cover_letter, source: 'cached' };
  }

  const base = (profile?.cover_letter || '').trim();

  // No LLM configured or reachable → the template still works. Better a rendered
  // template than an empty field.
  const fallback = () => {
    const t = renderTemplate(base, { job, profile });
    return t ? { text: t, source: 'template' } : { text: '', source: 'none' };
  };

  // Use the CV variant that best matches this posting — the letter should echo the
  // same evidence the reviewer is about to read. Fall back to the profile's CV text.
  let cv = '';
  try {
    const { best } = await rankVariantsForJob(profile.id, job);
    cv = best?.cv_text || '';
  } catch { /* variants are optional */ }
  if (!cv) {
    try { cv = JSON.parse(profile.filters || '{}').cv_text || ''; } catch { /* ignore */ }
  }

  const jd = String(job?.description || '').slice(0, 3500);
  if (!jd && !base) return fallback();

  const system = [
    'You write cover letters that hiring managers actually finish reading.',
    '',
    'RULES:',
    `  - ${words} words maximum. Three or four short paragraphs. No letterhead, no "Dear Sir/Madam".`,
    '  - Open with the specific reason THIS role at THIS company — reference something concrete',
    '    from the job description. Never open with "I am writing to apply for".',
    '  - Middle: map the candidate\'s strongest RELEVANT evidence onto the posting\'s stated',
    '    requirements. Prefer specifics (systems, scale, outcomes) over adjectives.',
    '  - Close with a short, confident line. No begging, no "I would be grateful".',
    '  - Plain sentences. No buzzword stacking, no "passionate", no "synergy", no em-dash pile-ups.',
    '',
    'HARD CONSTRAINT — every employer, title, date, metric and technology you attribute to the',
    'candidate must appear in their CV or profile below. If the posting wants something they do',
    'not have, either omit it or address it honestly as a transferable strength. Never invent.',
    '',
    'Output the letter body as plain text only. No preamble, no JSON, no markdown headings.',
  ].join('\n');

  const user = [
    `ROLE: ${job?.title || ''}${job?.company ? ' at ' + job.company : ''}`,
    job?.location ? `LOCATION: ${job.location}` : '',
    '',
    `JOB DESCRIPTION:\n${jd || '(not captured — rely on the role title)'}`,
    '',
    `CANDIDATE CV:\n${cv.slice(0, 5000) || '(no CV text available)'}`,
    base ? `\nTHE CANDIDATE'S OWN TEMPLATE (match this voice; reuse anything that fits):\n${base}` : '',
  ].filter(Boolean).join('\n');

  try {
    const raw = await chat(profile, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { num_predict: 900, temperature: 0.4, useSynthModel: true });

    const text = String(raw || '')
      .replace(/^```[a-z]*\n?|```$/g, '')
      .replace(/^\s*(here('|’)s|below is)[^\n]*\n+/i, '')   // strip chatty preambles
      .trim();

    if (text.split(/\s+/).length < 60) {
      lwarn(profile.id, '  ⚠ Cover letter came back too short — using your template instead.');
      return fallback();
    }
    await run('UPDATE jobs SET cover_letter = ? WHERE id = ?', [text, job.id]);
    return { text, source: 'generated' };
  } catch (e) {
    lwarn(profile.id, `  ⚠ Cover letter LLM unavailable (${e?.message || e}) — using your template.`);
    return fallback();
  }
}

/** Is this form field asking for a cover letter / motivation statement? */
export function isCoverLetterField(label = '', key = '') {
  const s = `${label} ${key}`.toLowerCase();
  if (/cover\s*letter|covering\s*letter|motivation(al)?\s*(letter|statement)/.test(s)) return true;
  if (/why (do you (want|wish)|are you interested)/.test(s) && /this (role|position|job|company)/.test(s)) return true;
  if (/tell us why you|what (draws|attracts) you/.test(s)) return true;
  return false;
}

export async function saveProfileCoverLetter(profileId, text) {
  await run('UPDATE profiles SET cover_letter = ? WHERE id = ?', [text || '', profileId]);
  const p = await get('SELECT cover_letter FROM profiles WHERE id = ?', [profileId]);
  return p?.cover_letter || '';
}
