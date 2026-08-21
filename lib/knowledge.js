// Semantic retrieval over a profile's answer bank + bio.
// Pattern mirrors /Portfolio/src/kb/embeddings.py: embed at write time, cosine-rank at read time,
// drop hits below a similarity threshold.

import { get, all, run } from './db.js';
import { embed, cosine } from './llm.js';

const SIM_THRESHOLD = 0.45;   // a touch tighter than Portfolio's 0.35 — form Qs are short, false matches are worse
const TOP_K = 8;

// Build the text that gets embedded for an answer row. Combining label+value gives the model
// something to match against regardless of how the new question is phrased.
function embedText(row) {
  return `${row.label || row.field_key}\n${row.value || ''}`.slice(0, 2000);
}

let _warnedEmbedDown = false;
export async function indexAnswer(profile, row) {
  try {
    const vec = await embed(profile, embedText(row));
    if (!vec) return;
    await run(
      'UPDATE answers SET embedding = ? WHERE profile_id = ? AND field_key = ?',
      [JSON.stringify(vec), profile.id, row.field_key]
    );
    _warnedEmbedDown = false;
  } catch (e) {
    // Embedding is best-effort — bank still works without it via field_key fallback.
    // Log only on the first failure to avoid spamming the Terminal when Ollama is down.
    if (!_warnedEmbedDown) {
      _warnedEmbedDown = true;
      console.warn('[knowledge] embed unavailable — answers will be saved without embeddings until Ollama is reachable. Click "Reindex bank" later to backfill. Reason:', e?.message || e);
    }
  }
}

// Make sure every row has an embedding (lazy backfill).
export async function backfillEmbeddings(profile) {
  const rows = await all(
    'SELECT * FROM answers WHERE profile_id = ? AND (embedding IS NULL OR embedding = \'\')',
    [profile.id]
  );
  for (const r of rows) await indexAnswer(profile, r);
  return rows.length;
}

// Returns the top-K answers most relevant to `question`, plus an exact field_key hit if any.
export async function retrieve(profile, question, { k = TOP_K, threshold = SIM_THRESHOLD } = {}) {
  if (!question) return { hits: [], exact: null };

  // 1) cheap exact match by normalized field_key
  const normalized = String(question).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  // Approved answers only. This function feeds BOTH the autofill writer and the
  // grounding context handed to the LLM, so gating here covers every consumer — an
  // unreviewed answer can neither be typed into a form nor quoted back by the model.
  const exact = await get(
    "SELECT * FROM answers WHERE profile_id = ? AND field_key = ? AND status = 'approved'",
    [profile.id, normalized]
  );

  // 2) semantic top-K
  let queryVec;
  try { queryVec = await embed(profile, question); } catch { queryVec = null; }
  if (!queryVec) {
    // Embedding offline — return the exact hit if any, plus most-used answers as weak fallback.
    const fallback = await all(
      "SELECT * FROM answers WHERE profile_id = ? AND status = 'approved' ORDER BY hit_count DESC LIMIT ?",
      [profile.id, k]
    );
    return { hits: fallback, exact };
  }

  const rows = await all("SELECT * FROM answers WHERE profile_id = ? AND status = 'approved'", [profile.id]);
  const scored = [];
  for (const r of rows) {
    if (!r.embedding) continue;
    let vec;
    try { vec = JSON.parse(r.embedding); } catch { continue; }
    const score = cosine(queryVec, vec);
    if (score >= threshold) scored.push({ ...r, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return { hits: scored.slice(0, k), exact };
}
