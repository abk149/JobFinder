// On-demand learning — the iterative half of the prep engine.
//
// The dictionary-driven build (synthesize.js) covers what your saved job ads demand.
// This module covers everything else: you ask about a concept in chat, and if the
// knowledge base doesn't already cover it we research it live, write a study note,
// store it with its links, and answer from the freshly-written material.
//
// The result is cumulative — ask about MCP once and it's permanently in your KB,
// citable by later questions, and searchable alongside the JD-derived topics.

import crypto from 'node:crypto';
import { run, get } from '../db.js';
import { chat } from '../llm.js';
import { SKILLS } from './skills.js';
import { researchSkill } from './research.js';
import { renderNoteBody } from './synthesize.js';
import { indexNote } from './kb.js';
import { classifyTerm } from './discover.js';
import { linfo, lok, lwarn } from '../logger.js';

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
 * Turn a natural-language question into the topic to research.
 *   "can you explain MCP in detail?"            → "MCP"
 *   "how do you train a model on proprietary data" → "training models on proprietary data"
 *
 * Heuristics first (fast, no LLM). Falls back to the raw question, which
 * researchSkill handles fine — it's just a search term.
 */
export function topicFromQuestion(question) {
  let q = String(question || '').trim().replace(/\s+/g, ' ');
  q = q.replace(/[?.!]+$/, '');
  const patterns = [
    /^(?:can you |could you |please )?(?:explain|describe|teach me|tell me about|what is|what are|what's|whats)\s+(?:the\s+)?(?:concept of\s+)?(.+?)(?:\s+in detail| in depth| to me| please)?$/i,
    /^(?:how do (?:you|i)|how to|how does)\s+(.+?)$/i,
    /^(?:i want to learn|help me (?:learn|understand)|deep dive (?:on|into))\s+(.+?)$/i,
  ];
  for (const re of patterns) {
    const m = q.match(re);
    if (m && m[1] && m[1].length >= 2) return m[1].trim();
  }
  return q;
}

/**
 * Look up curated docs for a topic.
 *
 * Important subtlety: an alias match does NOT rename the topic. The dictionary lists
 * "weaviate" as an alias of "Vector Databases", but if you ask "explain Weaviate"
 * you want a note about Weaviate — not a generic vector-database overview. So an
 * alias only lends its docs URL; only an exact canonical-name match renames.
 */
function curatedDocsFor(topic) {
  const t = topic.toLowerCase().trim();
  for (const [canonical, def] of Object.entries(SKILLS)) {
    if (canonical.toLowerCase() === t) return { canonical, docs: def.docs || '', exact: true };
  }
  for (const [canonical, def] of Object.entries(SKILLS)) {
    for (const a of def.aliases || []) {
      if (a.replace(/\\/g, '').toLowerCase() === t) {
        // Keep the user's wording; borrow the category's docs as a starting point.
        return { canonical: topic, docs: def.docs || '', viaAlias: canonical, exact: false };
      }
    }
  }
  return null;
}

function noteId(profileId, kind, key) {
  return crypto.createHash('sha1').update(`${profileId}|${kind}|${key}`).digest('hex').slice(0, 20);
}
function sourceRowId(profileId, url) {
  return crypto.createHash('sha1').update(`${profileId}|${url}`).digest('hex').slice(0, 20);
}

/**
 * Research a topic from scratch and add it to the prep knowledge base.
 *
 * @param topic  what to learn, e.g. "MCP" or "training models on proprietary data"
 * @returns { ok, topic, noteId, body, sources, reason }
 */
export async function learnTopic(profile, topic, { ctx = null, depth = 'normal' } = {}) {
  const pid = profile.id;
  const clean = String(topic || '').trim().slice(0, 120);
  if (clean.length < 2) return { ok: false, reason: 'topic too short' };

  // Prefer the curated canonical name + docs when we already know this concept, so
  // "mcp" and "Model Context Protocol" don't become two separate notes.
  const curated = curatedDocsFor(clean);
  const canonical = curated?.canonical || clean;
  let docsUrl = curated?.docs || '';

  linfo(pid, `  🔎 Researching "${canonical}"…`);

  // For unknown topics, borrow the Wikipedia URL as a starting reference if the
  // term classifies as a real technology.
  if (!docsUrl) {
    const verdict = await classifyTerm(canonical, { curated: null }).catch(() => null);
    if (verdict?.docsHint) docsUrl = verdict.docsHint;
    if (verdict && !verdict.isTech) {
      linfo(pid, `     (not a recognised technology — ${verdict.reason}; researching anyway)`);
    }
  }

  const sources = await researchSkill(canonical, { docsUrl, ctx, pid });
  if (!sources.length) {
    lwarn(pid, `  ⚠ No sources found for "${canonical}".`);
    return { ok: false, reason: 'no sources found', topic: canonical };
  }

  const material = sources
    .map((s, i) => `[${i + 1}] (${s.kind}) ${s.title}\nURL: ${s.url}\n${(s.content || '').slice(0, 1100)}`)
    .join('\n\n');

  let bio = '';
  try {
    const f = typeof profile.filters === 'string' ? JSON.parse(profile.filters) : profile.filters || {};
    bio = f.bio || '';
  } catch { /* ignore */ }

  const system = [
    'You are a staff-level practitioner writing a study note on a technical topic.',
    depth === 'deep'
      ? 'Write a THOROUGH explanation — assume the reader wants to understand this properly, not just pass a quiz.'
      : 'Write a focused explanation aimed at discussing this confidently in a senior interview.',
    '',
    'CRITICAL — write PRODUCTION-GRADE material:',
    '  - Explain how the industry ACTUALLY does this at scale: established patterns, the',
    '    trade-offs experienced engineers weigh, what breaks in production, what good teams do.',
    '  - Answer as an expert would, NOT limited to the reader\'s personal experience. Their',
    '    background sets the LEVEL you pitch at, not the ceiling on what a good answer contains.',
    '  - Where their background gives a genuine hook, note it in "your_angle". If there is no',
    '    honest connection, leave it as an empty string — never manufacture one.',
    '',
    'Base the material on the numbered sources. Cite them inline as [1], [2]. Only cite numbers that exist.',
    'If the sources are thin, say what is well-established versus what you are inferring.',
    '',
    'Produce a JSON object with exactly these keys:',
    '{',
    '  "brief": "the core explanation, 200-350 words, cited inline",',
    '  "key_points": ["5-7 things to remember"],',
    '  "production_notes": ["3-5 things that only show up at real production scale: gotchas, limits, what good teams do differently"],',
    '  "questions": [{"q":"a question an interviewer might ask","a":"the production-grade answer, 3-5 sentences, as an expert would give it","your_angle":"optional short note tying the reader\'s experience in, or empty string"}],',
    '  "drill": "one concrete thing to try or practise",',
    '  "gap": "one sentence on the subtlety people most often get wrong here"',
    '}',
    'Include 3-4 questions. Respond with ONLY the JSON object.',
  ].join('\n');

  const user = [
    `TOPIC: ${canonical}`,
    // Their background calibrates the LEVEL of the explanation. It is explicitly not
    // a constraint on the content — that framing is what made earlier notes read like
    // a rehash of the reader's CV instead of industry best practice.
    bio ? `\nWHO IS ASKING (use this ONLY to pitch the level, not to limit the content):\n${bio}` : '',
    `\nSOURCES:\n${material}`,
  ].filter(Boolean).join('\n');

  let note = null;
  for (let attempt = 1; attempt <= 2 && !note; attempt++) {
    const raw = await chat(profile, [
      { role: 'system', content: attempt === 1 ? system : system + '\nIMPORTANT: output a single JSON object and nothing else.' },
      { role: 'user', content: user },
    ], {
      num_predict: attempt === 1 ? 1700 : 1200,
      temperature: attempt === 1 ? 0.4 : 0.2,
      json: true,
      useSynthModel: true,
    });
    const parsed = extractJson(raw);
    if (parsed && (parsed.brief || parsed.questions)) note = parsed;
    else if (attempt === 1) lwarn(pid, `    ↻ "${canonical}": unparseable JSON, retrying…`);
  }
  if (!note) {
    lwarn(pid, `  ⚠ Could not synthesize a note for "${canonical}".`);
    return { ok: false, reason: 'synthesis failed', topic: canonical, sources };
  }

  const body = renderNoteBody(canonical, note);

  const now = Date.now();
  const day = new Date().toISOString().slice(0, 10);
  const id = noteId(pid, 'topic', canonical.toLowerCase());

  for (const s of sources) {
    try {
      await run(
        `INSERT INTO prep_sources (id, profile_id, kind, title, url, content, meta, collected_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, collected_at=excluded.collected_at`,
        [sourceRowId(pid, s.url), pid, s.kind, s.title || '', s.url, s.content || '', JSON.stringify({ topic: canonical }), now]
      );
    } catch { /* skip bad row */ }
  }

  await run(
    `INSERT INTO prep_notes (id, profile_id, topic, kind, title, body, source_ids, created_at, day, evidence, demand, sources_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       body=excluded.body, created_at=excluded.created_at, day=excluded.day, sources_json=excluded.sources_json`,
    [
      id, pid, canonical, 'asked', canonical, body, '[]', now, day,
      'You asked about this in chat.', 0,
      JSON.stringify({
        references: sources.map((s, i) => ({ n: i + 1, kind: s.kind, title: s.title, url: s.url, purpose: s.purpose || 'reference' })),
        jobs: [],
        docs: docsUrl,
      }),
    ]
  );
  await indexNote(profile, { id, topic: canonical, title: canonical, body }).catch(() => {});
  lok(pid, `  ✓ Learned "${canonical}" — ${sources.length} source(s), added to your knowledge base`);

  return { ok: true, topic: canonical, noteId: id, body, sources };
}
