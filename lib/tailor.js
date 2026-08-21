// CV gap analysis and per-job tailoring.
//
// Most rejections are keyword filters, not human judgement: an ATS scores your CV
// against the posting before a person ever sees it. If the ad says "Kubernetes" and
// your CV says "container orchestration", you lose — regardless of whether you can
// do the job.
//
// Two things happen here:
//   1. GAP ANALYSIS (deterministic, instant, no LLM). Which skills does this posting
//      require that your CV never names? Split into "you have it, you just didn't
//      say it" versus "you genuinely don't have it" using your answer bank and bio
//      as corroborating evidence.
//   2. TAILORING (LLM). Rewrite your summary and suggest bullet edits that surface
//      the covered gaps in the posting's own vocabulary.
//
// Hard rule enforced in the prompt AND checked afterwards: tailoring may only
// re-word experience you actually have. Inventing skills to pass a keyword filter
// gets you caught in the interview and is worse than being filtered out.

import { matchSkillsInText } from './prep/skills.js';
import { parseFilters } from './profileSettings.js';
import { chat } from './llm.js';
import { htmlToText } from '../connectors/_util.js';

/** Pull the first JSON value out of an LLM response, tolerating fences and prose. */
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.search(/[[{]/);
  if (start === -1) return null;
  const open = t[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === open) depth++;
    else if (t[i] === close) {
      depth--;
      if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } }
    }
  }
  return null;
}

/**
 * Compare a job posting against the candidate's CV.
 *
 * @returns {
 *   required, present, missingButEvidenced, missingEntirely,
 *   coverage, atsRisk, hasCv
 * }
 */
export function analyseGap(job, profile, answers = []) {
  const filters = parseFilters(profile);
  const cvText = filters.cv_text || '';
  const hasCv = cvText.replace(/\s/g, '').length > 200;

  const jd = htmlToText(job.description || '', 9000);
  const required = [
    ...new Set(
      [
        ...matchSkillsInText(jd).map((s) => s.skill),
        ...matchSkillsInText(`${job.title || ''}`).map((s) => s.skill),
      ]
    ),
  ];

  const inCv = new Set(matchSkillsInText(cvText).map((s) => s.skill));

  // Corroborating evidence: things you've told employers before, or wrote in your
  // bio, count as "you have this, it's just missing from the CV" — a fixable gap
  // rather than a real one.
  const corroborating = [
    filters.bio || '',
    profile.keywords || '',
    answers.map((a) => `${a.label || a.field_key}: ${a.value}`).join('\n'),
  ].join('\n');
  const inEvidence = new Set(matchSkillsInText(corroborating).map((s) => s.skill));

  const present = required.filter((s) => inCv.has(s));
  const rest = required.filter((s) => !inCv.has(s));
  const missingButEvidenced = rest.filter((s) => inEvidence.has(s));
  const missingEntirely = rest.filter((s) => !inEvidence.has(s));

  const coverage = required.length ? Math.round((present.length / required.length) * 100) : null;

  // ATS risk: how likely an automated filter drops this before a human reads it.
  let atsRisk = 'unknown';
  if (!hasCv) atsRisk = 'unknown';
  else if (coverage === null) atsRisk = 'unknown';
  else if (coverage >= 70) atsRisk = 'low';
  else if (coverage >= 45) atsRisk = 'medium';
  else atsRisk = 'high';

  return {
    required, present, missingButEvidenced, missingEntirely,
    coverage, atsRisk, hasCv,
  };
}

/**
 * Generate tailored CV content for one job.
 *
 * Only ever re-words experience the candidate can evidence. Skills in
 * `missingEntirely` are reported as genuine gaps and explicitly excluded from the
 * rewrite — the model is told not to claim them.
 */
export async function tailorForJob(job, profile, answers = [], gap = null) {
  const filters = parseFilters(profile);
  const cvText = filters.cv_text || '';
  const analysis = gap || analyseGap(job, profile, answers);

  if (!analysis.hasCv) {
    return {
      ok: false,
      reason: 'No CV text available. Upload a text-based PDF, or paste your CV in the Profile tab.',
      gap: analysis,
    };
  }

  const jd = htmlToText(job.description || '', 4000);
  const evidence = answers.slice(0, 20).map((a) => `- ${a.label || a.field_key}: ${a.value}`).join('\n');

  const system = [
    'You tailor a CV to one specific job posting so it survives ATS keyword screening and reads well to a hiring manager.',
    '',
    'ABSOLUTE RULE — never fabricate:',
    '  - You may only re-word, re-frame, and re-prioritise experience the candidate demonstrably has.',
    '  - "SAFE TO SURFACE" skills are ones they have evidence for but did not name in the CV. Use the posting\'s exact vocabulary for these.',
    '  - "GENUINE GAPS" are skills they have no evidence for. NEVER claim these. Do not imply them. You may suggest how to address the gap honestly, in the "gap_strategy" field only.',
    '  - Never invent employers, job titles, dates, metrics, or numbers not present in the CV.',
    '',
    'Produce a JSON object with exactly these keys:',
    '{',
    '  "summary": "a 2-4 sentence professional summary rewritten for THIS posting, using its vocabulary, grounded only in real experience",',
    '  "bullets": [{"original":"an existing CV bullet, quoted or closely paraphrased","rewritten":"the same achievement re-worded to surface relevant keywords","why":"which posting requirement this now addresses"}],',
    '  "keywords_to_add": ["exact terms from the posting the candidate can honestly claim but the CV never names"],',
    '  "gap_strategy": "one honest paragraph on the genuine gaps: how to address them in a cover letter or interview without pretending to have them"',
    '}',
    'Give 3-5 bullets. Respond with ONLY the JSON object.',
  ].join('\n');

  const user = [
    `JOB: ${job.title || ''}${job.company ? ' at ' + job.company : ''}`,
    `\nPOSTING:\n${jd}`,
    `\nSAFE TO SURFACE (they have evidence, CV doesn't name them): ${analysis.missingButEvidenced.join(', ') || '(none)'}`,
    `\nGENUINE GAPS (no evidence — DO NOT CLAIM): ${analysis.missingEntirely.join(', ') || '(none)'}`,
    `\nALREADY IN CV: ${analysis.present.join(', ') || '(none)'}`,
    evidence ? `\nEVIDENCE FROM PAST APPLICATIONS:\n${evidence}` : '',
    `\nCURRENT CV:\n${cvText.slice(0, 6000)}`,
  ].filter(Boolean).join('\n');

  let out = null;
  for (let attempt = 1; attempt <= 2 && !out; attempt++) {
    const raw = await chat(profile, [
      { role: 'system', content: attempt === 1 ? system : system + '\nIMPORTANT: output a single JSON object and nothing else.' },
      { role: 'user', content: user },
    ], {
      num_predict: attempt === 1 ? 1700 : 1300,
      temperature: attempt === 1 ? 0.35 : 0.2,
      json: true,
      useSynthModel: true,
    });
    const parsed = extractJson(raw);
    if (parsed && (parsed.summary || parsed.bullets)) out = parsed;
  }
  if (!out) return { ok: false, reason: 'The model did not return usable JSON. Try again.', gap: analysis };

  // Post-check the no-fabrication rule rather than trusting the prompt. If a genuine
  // gap shows up in the generated text, flag it so the user can't be blindsided.
  const generated = `${out.summary || ''} ${(out.bullets || []).map((b) => b.rewritten).join(' ')} ${(out.keywords_to_add || []).join(' ')}`.toLowerCase();
  const violations = analysis.missingEntirely.filter((s) => {
    const t = s.replace(/\(.*?\)/g, '').trim().toLowerCase();
    return t.length >= 3 && generated.includes(t);
  });

  return { ok: true, gap: analysis, ...out, violations };
}
