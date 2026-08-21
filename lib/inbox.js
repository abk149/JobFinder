// Recruiter-reply parsing → pipeline updates.
//
// DESIGN CHOICE: paste-in, not inbox-connected.
//
// The obvious version of this feature connects to your mailbox over IMAP. I did not
// build that, deliberately:
//   • It requires storing your email password or an OAuth token on disk, in an app
//     that already holds your CV, your saved answers and your browser sessions.
//     That's a large, permanent credential surface for a convenience feature.
//   • Reading a whole mailbox means ingesting messages that have nothing to do with
//     job hunting.
//   • The actual work — "which job is this about, and what stage does it mean" — is
//     identical whether the text arrives by IMAP or by paste.
//
// So: paste the reply, it matches it to a saved job, tells you what it means, and
// offers the status change. You stay in the loop on every update, and no credential
// is ever stored. If you later want IMAP, it slots in behind the same parser.

import { all } from './db.js';
import { chat } from './llm.js';
import { normalizeCompany } from './fit.js';

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

/**
 * Match an email to one of the user's saved jobs.
 *
 * Lexical, not semantic: we're looking for the company name appearing in the text,
 * which is reliable and instant. Ambiguity is returned rather than guessed at — the
 * cost of silently updating the wrong application is high.
 */
export async function matchJob(profileId, emailText) {
  const text = String(emailText || '').toLowerCase();
  const jobs = await all(
    `SELECT id, title, company, status, url FROM jobs
      WHERE profile_id = ? AND status NOT IN ('skipped')`,
    [profileId]
  );

  const scored = [];
  for (const j of jobs) {
    const comp = normalizeCompany(j.company);
    if (!comp || comp.length < 3) continue;
    let score = 0;
    if (text.includes(comp)) score += 5;
    if (j.company && text.includes(String(j.company).toLowerCase())) score += 3;
    // A title match on top of a company match is strong corroboration.
    const titleWords = String(j.title || '').toLowerCase().split(/\W+/).filter((w) => w.length > 4);
    if (titleWords.length) {
      const hits = titleWords.filter((w) => text.includes(w)).length;
      score += Math.min(3, hits);
    }
    // Applications you've actually sent are far likelier to receive a reply.
    if (['applied', 'screening', 'interview'].includes(j.status)) score += 2;
    if (score >= 5) scored.push({ job: j, score });
  }
  scored.sort((a, b) => b.score - a.score);

  return {
    best: scored[0]?.job || null,
    confident: scored.length > 0 && (scored.length === 1 || scored[0].score > scored[1].score + 2),
    candidates: scored.slice(0, 5).map((s) => ({ ...s.job, score: s.score })),
  };
}

/**
 * Classify what a recruiter reply means for the pipeline.
 * @returns { stage, summary, action, date, confidence }
 */
export async function classifyEmail(profile, emailText) {
  const system = [
    'You read a recruiter or hiring-manager email and decide what it means for a job application pipeline.',
    '',
    'Choose exactly one stage:',
    '  rejected  — declined, "moving forward with other candidates", position closed',
    '  screening — recruiter wants a call, screening chat, or asks availability for an initial conversation',
    '  interview — a technical/panel/onsite interview is being scheduled or has been confirmed',
    '  offer     — an offer is being made or terms are being discussed',
    '  applied   — mere acknowledgement of receipt, no human action yet',
    '  unknown   — genuinely cannot tell',
    '',
    'Recruiters very often write to REQUEST something — notice period, salary expectation,',
    'availability, an updated CV, documents, a form. Capture each request separately in',
    '"asks": that list is the whole point of reading the mail, and burying it inside a',
    'summary sentence makes it easy to miss one and stall the application.',
    '',
    'Respond with ONLY a JSON object:',
    '{"stage":"screening",',
    ' "summary":"one sentence on what they are asking for",',
    ' "action":"what the candidate should do next",',
    ' "asks":["each specific thing they want from the candidate, one per entry; [] if none"],',
    ' "deadline":"any deadline stated, verbatim, or empty string",',
    ' "date":"any date/time mentioned, verbatim, or empty string",',
    ' "confidence":"high|medium|low"}',
  ].join('\n');

  const raw = await chat(profile, [
    { role: 'system', content: system },
    { role: 'user', content: String(emailText || '').slice(0, 6000) },
  ], { num_predict: 1200, temperature: 0.1, json: true, useSynthModel: true, timeoutMs: 120000 });

  const parsed = extractJson(raw);
  if (!parsed?.stage) return null;

  const VALID = ['rejected', 'screening', 'interview', 'offer', 'applied', 'unknown'];
  if (!VALID.includes(parsed.stage)) parsed.stage = 'unknown';
  if (!Array.isArray(parsed.asks)) parsed.asks = parsed.asks ? [String(parsed.asks)] : [];
  parsed.asks = parsed.asks.map((a) => String(a).trim()).filter(Boolean).slice(0, 8);
  // "Do I have to do something?" is the question the inbox view is really answering.
  parsed.action_required = parsed.asks.length > 0 ||
    ['screening', 'interview', 'offer'].includes(parsed.stage);
  return parsed;
}
