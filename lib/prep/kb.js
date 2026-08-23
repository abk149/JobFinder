// The interview-prep knowledge base and its Q&A bot.
//
// Deliberately SEPARATE from the application answer bank (lib/knowledge.js):
//   - answer bank  → facts about the candidate, used to fill forms
//   - prep KB      → synthesized study material, used to answer study questions
// Mixing them would pollute form-filling with essay text and pollute study answers
// with "notice period: 30 days"-style trivia.
//
// Notes are chunked, embedded with all-minilm, and retrieved by cosine
// similarity. The bot answers strictly from retrieved chunks and says so when the
// KB doesn't cover something, rather than free-associating.

import crypto from 'node:crypto';
import { all, run, get } from '../db.js';
import { embed, cosine, chat } from '../llm.js';

const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 150;
// Measured against nomic-embed-text: genuinely relevant chunks score 0.58-0.75,
// while unrelated questions ("how do I cook risotto?") still reach ~0.35-0.45. A
// 0.35 threshold therefore let off-topic questions claim to be "grounded" in the
// study material. 0.52 keeps real hits and rejects the noise.
const SIM_THRESHOLD = 0.52;
const TOP_K = 6;

/** Split a note body into overlapping chunks that embed well. */
function chunkText(text) {
  const t = String(text || '').trim();
  if (t.length <= CHUNK_CHARS) return t ? [t] : [];
  const chunks = [];
  let i = 0;
  while (i < t.length) {
    let end = Math.min(i + CHUNK_CHARS, t.length);
    // Prefer to break on a paragraph or sentence boundary.
    if (end < t.length) {
      const window = t.slice(i, end);
      const br = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '));
      if (br > CHUNK_CHARS * 0.5) end = i + br + 1;
    }
    chunks.push(t.slice(i, end).trim());
    if (end >= t.length) break;
    i = end - CHUNK_OVERLAP;
  }
  return chunks.filter(Boolean);
}

function chunkId(noteId, idx) {
  return crypto.createHash('sha1').update(`${noteId}|${idx}`).digest('hex').slice(0, 20);
}

/**
 * Embed a note into the prep KB. Replaces any existing chunks for that note so a
 * re-synthesis doesn't leave stale material behind.
 */
export async function indexNote(profile, note) {
  await run('DELETE FROM prep_chunks WHERE note_id = ?', [note.id]);
  const chunks = chunkText(note.body);
  let indexed = 0;
  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i];
    let vec = null;
    try {
      vec = await embed(profile, `${note.title || note.topic}\n${text}`);
    } catch {
      // Embedding unavailable (Ollama down / model missing). Store the chunk anyway
      // without a vector — keyword fallback in askPrep() will still find it.
    }
    await run(
      `INSERT INTO prep_chunks (id, profile_id, note_id, topic, text, embedding, created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET text=excluded.text, embedding=excluded.embedding`,
      [chunkId(note.id, i), profile.id, note.id, note.topic || '', text, vec ? JSON.stringify(vec) : null, Date.now()]
    );
    indexed++;
  }
  return indexed;
}

/** Backfill embeddings for any chunks stored while Ollama was unavailable. */
export async function backfillPrepEmbeddings(profile) {
  const rows = await all(
    "SELECT id, topic, text FROM prep_chunks WHERE profile_id = ? AND (embedding IS NULL OR embedding = '')",
    [profile.id]
  );
  let n = 0;
  for (const r of rows) {
    try {
      const vec = await embed(profile, `${r.topic}\n${r.text}`);
      if (!vec) continue;
      await run('UPDATE prep_chunks SET embedding = ? WHERE id = ?', [JSON.stringify(vec), r.id]);
      n++;
    } catch {
      break; // embeddings are down; stop trying
    }
  }
  return n;
}

/** Retrieve the most relevant prep chunks for a question. */
export async function retrievePrep(profile, question, { k = TOP_K, threshold = SIM_THRESHOLD } = {}) {
  const rows = await all(
    'SELECT id, note_id, topic, text, embedding FROM prep_chunks WHERE profile_id = ?',
    [profile.id]
  );
  if (!rows.length) return [];

  let qVec = null;
  try { qVec = await embed(profile, question); } catch { /* fall back to keyword */ }

  if (!qVec) {
    // Keyword fallback so the bot still works when embeddings are unavailable.
    const words = String(question).toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    return rows
      .map((r) => {
        const hay = `${r.topic} ${r.text}`.toLowerCase();
        const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0) / (words.length || 1);
        return { ...r, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  // Hybrid retrieval: cosine similarity PLUS a lexical topic match.
  //
  // Pure cosine misses an obvious case — you ask "What is Weaviate and how would I
  // use it?" right after a note titled "Weaviate" was written, but the note's prose
  // is about vector indexing and scores below threshold. If the question literally
  // names a note's topic, that note is relevant regardless of what cosine says.
  const qLower = String(question).toLowerCase();
  const namesTopic = (topic) => {
    const t = String(topic || '').toLowerCase().trim();
    if (t.length < 3) return false;
    if (qLower.includes(t)) return true;
    // Also match on the topic's distinctive words (>=4 chars), e.g. "Vector
    // Databases" when the question says "vector database".
    const words = t.split(/[^a-z0-9+#.]+/).filter((w) => w.length >= 4);
    return words.length > 0 && words.every((w) => qLower.includes(w));
  };

  const scored = [];
  for (const r of rows) {
    if (!r.embedding) continue;
    let vec;
    try { vec = JSON.parse(r.embedding); } catch { continue; }
    const score = cosine(qVec, vec);
    const lexical = namesTopic(r.topic);
    // A lexical topic hit is boosted over the threshold; cosine still orders results.
    if (score >= threshold || lexical) {
      scored.push({ ...r, score, lexical, rank: lexical ? score + 0.25 : score });
    }
  }
  scored.sort((a, b) => b.rank - a.rank);
  return scored.slice(0, k);
}

/**
 * Ask the prep bot a question. Answers strictly from retrieved prep material.
 * @returns { answer, sources: [{topic, score, noteId}], grounded }
 */
export async function askPrep(profile, question) {
  const hits = await retrievePrep(profile, question);

  if (!hits.length) {
    return {
      answer:
        "I don't have anything in your prep knowledge base about that yet. Hit **Refresh prep** on the Interview Prep tab to collect and synthesize material — then ask me again.",
      sources: [],
      grounded: false,
    };
  }

  const context = hits
    .map((h, i) => `[${i + 1}] (topic: ${h.topic})\n${h.text}`)
    .join('\n\n');

  const system = [
    'You are a staff-level practitioner acting as the candidate\'s interview-prep tutor.',
    'Answer using the STUDY MATERIAL below, which was researched and written for them.',
    'Rules:',
    '- Give the PRODUCTION-GRADE answer — how strong engineers at good companies actually',
    '  handle this. Do NOT restrict the answer to the candidate\'s own past experience;',
    '  their background is context for pitching the level, not a limit on the content.',
    '- Ground technical claims in the material and cite snippet numbers, like [1] or [2].',
    '- If the material only partially covers the question, answer what it supports and say',
    '  plainly what it does not cover.',
    '- If it does not cover the question at all, say so — do not invent study content.',
    '- Be direct and practical. Aim for 4-8 sentences unless the question needs more.',
    '- Facts about the CANDIDATE (employers, dates, numbers) must come only from the material;',
    '  never invent those. Industry facts should be as specific as the material supports.',
    '- Where their background gives a genuine hook, add one short closing line starting',
    '  "Your angle:" — but only if the connection is real.',
  ].join('\n');

  const answer = await chat(profile, [
    { role: 'system', content: system },
    { role: 'user', content: `STUDY MATERIAL:\n${context}\n\nQUESTION: ${question}` },
  ], { num_predict: 900, temperature: 0.3 });

  return {
    answer: answer || '(the model returned an empty response — try rephrasing)',
    sources: hits.map((h) => ({ topic: h.topic, score: Number(h.score?.toFixed?.(3) ?? h.score), noteId: h.note_id })),
    grounded: true,
  };
}

/** Stats for the UI header. */
export async function prepStats(profileId) {
  const s = await get('SELECT COUNT(*) AS n FROM prep_sources WHERE profile_id = ?', [profileId]);
  const n = await get('SELECT COUNT(*) AS n FROM prep_notes WHERE profile_id = ?', [profileId]);
  const c = await get('SELECT COUNT(*) AS n FROM prep_chunks WHERE profile_id = ?', [profileId]);
  const latest = await get(
    'SELECT day FROM prep_notes WHERE profile_id = ? ORDER BY created_at DESC LIMIT 1',
    [profileId]
  );
  return {
    sources: s?.n || 0,
    notes: n?.n || 0,
    chunks: c?.n || 0,
    lastRefreshDay: latest?.day || null,
  };
}
