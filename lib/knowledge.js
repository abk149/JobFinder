// Semantic retrieval over a profile's answer bank + bio.
// Pattern mirrors /Portfolio/src/kb/embeddings.py: embed at write time, cosine-rank at read time,
// drop hits below a similarity threshold.

import { get, all, run } from './db.js';
import { embed, cosine } from './llm.js';

// Tuned against all-minilm (see EMBED_MODEL in llm.js for why that model). Its cosines
// run lower than nomic's did, so the old 0.45 here dropped genuinely useful context:
// real matches in this bank land as low as 0.35 ("Which university did you attend" ->
// school). 0.30 keeps those as LLM grounding, while the separate, stricter
// SEMANTIC_CONFIDENT bar in autofill.js decides what may be typed in verbatim.
const SIM_THRESHOLD = 0.30;
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

// Make sure every row has a CURRENT embedding.
//
// "Current" matters as much as "present". Vectors from a different embedding model are
// not comparable, and cosine() returns 0 on a length mismatch — so after a model change
// every stored vector silently scores zero and the bank goes quiet rather than wrong.
// That is the safe failure, but it is still a failure, so detect it here: probe the live
// model for its dimension and re-embed anything that doesn't match. This makes the
// switch self-healing for existing installs, which matters because the answer bank is
// the one piece of user data an upgrade must never invalidate.
export async function backfillEmbeddings(profile) {
  let dim = 0;
  try { dim = (await embed(profile, 'dimension probe'))?.length || 0; } catch { /* offline */ }

  const rows = await all('SELECT * FROM answers WHERE profile_id = ?', [profile.id]);
  const stale = rows.filter((r) => {
    if (!r.embedding) return true;
    if (!dim) return false;               // can't probe → don't churn
    try { return JSON.parse(r.embedding).length !== dim; } catch { return true; }
  });
  for (const r of stale) await indexAnswer(profile, r);
  return stale.length;
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
