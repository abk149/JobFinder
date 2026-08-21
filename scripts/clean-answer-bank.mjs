// One-off repair for answer banks poisoned by the autofill feedback loop.
//
// Until this was fixed, setNativeValue dispatched 'change', the observer heard it,
// and every value autofill GUESSED was stored as though the user had typed it. Those
// rows then became exact-key matches, which outrank semantic search entirely — so a
// single wrong guess propagated into every later application and never got revisited.
//
// This pass removes rows that cannot be true, and merges the duplicate keys that the
// same fact accumulated across sites. Run with --apply to write; default is a dry run.
//
//   node scripts/clean-answer-bank.mjs            # show what would change
//   node scripts/clean-answer-bank.mjs --apply    # do it (backs up the DB first)

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// lib/db.js lazy-loads better-sqlite3 through require(); ESM scripts have no global
// require, so provide one. Also run from the repo root so the default DB path resolves.
globalThis.require = createRequire(import.meta.url);
process.chdir(join(dirname(fileURLToPath(import.meta.url)), '..'));

const { all, run } = await import('../lib/db.js');
const { junkReason, canonicalKey } = await import('../lib/answerBank.js');
const { copyFileSync, existsSync } = await import('node:fs');

async function main() {
  const APPLY = process.argv.includes('--apply');
  const DB = process.env.JOBFINDER_DB || 'data/jobfinder.db';

  const rows = await all('SELECT rowid, profile_id, field_key, label, value, type, hit_count, last_seen FROM answers');
  console.log(`answer bank: ${rows.length} rows\n`);

  // ── 1. rows that cannot be true ───────────────────────────────────────────────
  const doomed = [];
  for (const r of rows) {
    const why = junkReason(r.field_key, r.value, r.type);
    if (why) doomed.push({ ...r, why });
  }

  // ── 1b. the feedback-loop signature ───────────────────────────────────────────
  // One value spread across many unrelated fields is the fingerprint of the bug: a
  // single weak semantic guess got written into field after field, and each write was
  // re-learned as fact. "Kolkata" ending up as your certifications, your education,
  // your LinkedIn URL and your portfolio did not happen by typing. Keep the one row
  // where the value is actually plausible, drop the rest.
  const byValue = new Map();
  for (const r of rows) {
    if (doomed.some((d) => d.rowid === r.rowid)) continue;
    const v = String(r.value).trim();
    if (!byValue.has(v)) byValue.set(v, []);
    byValue.get(v).push(r);
  }
  for (const [v, list] of byValue) {
    const distinct = new Set(list.map((r) => canonicalKey(r.field_key, r.type)));
    if (distinct.size < 3) continue; // 2 copies is ordinary duplication, handled below
    const ranked = [...list].sort((a, b) => (b.hit_count || 0) - (a.hit_count || 0));
    for (const r of ranked.slice(1)) {
      doomed.push({ ...r, why: `same value in ${distinct.size} unrelated fields — autofill loop residue` });
    }
  }

  // ── 1c. your name showing up where it is not your name ────────────────────────
  // "primary skills = <your full name>" is the loop again: the name was the nearest
  // vector neighbour for an unrelated field. Only a name field may hold the name.
  const nameVals = new Set(
    rows.filter((r) => /^(full|first|last) name$/.test(canonicalKey(r.field_key, r.type)))
        .map((r) => String(r.value).trim().toLowerCase())
  );
  for (const r of rows) {
    if (doomed.some((d) => d.rowid === r.rowid)) continue;
    const k = canonicalKey(r.field_key, r.type);
    if (/name/.test(k)) continue;
    if (nameVals.has(String(r.value).trim().toLowerCase())) {
      doomed.push({ ...r, why: 'your name stored in a field that is not a name' });
    }
  }

  // ── 2. duplicates: several keys holding the same fact ─────────────────────────
  // Group survivors by canonical key and keep one — the most-used, then most recent.
  const alive = rows.filter((r) => !doomed.some((d) => d.rowid === r.rowid));
  const groups = new Map();
  for (const r of alive) {
    const k = `${r.profile_id} ${canonicalKey(r.field_key, r.type)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  // Rows with no duplicate still get renamed to the canonical key, so a differently
  // worded field on the next site resolves to this answer instead of creating yet
  // another near-copy.
  const renamesOnly = [];
  for (const [k, list] of groups) {
    if (list.length !== 1) continue;
    const canon = k.slice(k.indexOf(' ') + 1);
    if (list[0].field_key !== canon) renamesOnly.push({ canon, row: list[0] });
  }

  const merges = [];
  for (const [k, list] of groups) {
    if (list.length < 2) continue;
    const canon = k.split(' ')[1];
    // Prefer the row already named canonically, then the most-used, then the newest.
    const sorted = [...list].sort(
      (a, b) => (b.field_key === canon) - (a.field_key === canon)
        || (b.hit_count || 0) - (a.hit_count || 0)
        || (b.last_seen || 0) - (a.last_seen || 0)
    );
    merges.push({ canon, keep: sorted[0], drop: sorted.slice(1) });
  }

  // ── report ────────────────────────────────────────────────────────────────────
  console.log(`── ${doomed.length} row(s) to DELETE (cannot be true) ──`);
  for (const d of doomed) {
    console.log(`  ✗ ${JSON.stringify(d.field_key).slice(0, 52).padEnd(54)} = ${JSON.stringify(d.value).slice(0, 34).padEnd(36)} ${d.why}`);
  }

  console.log(`\n── ${merges.length} duplicate group(s) to MERGE ──`);
  for (const m of merges) {
    console.log(`  → ${m.canon}`);
    console.log(`      keep  ${JSON.stringify(m.keep.field_key).slice(0, 46).padEnd(48)} = ${JSON.stringify(m.keep.value).slice(0, 40)}`);
    for (const d of m.drop) {
      console.log(`      drop  ${JSON.stringify(d.field_key).slice(0, 46).padEnd(48)} = ${JSON.stringify(d.value).slice(0, 40)}`);
    }
  }

  if (renamesOnly.length) {
    console.log(`\n── ${renamesOnly.length} key(s) to RENAME to canonical form ──`);
    for (const r of renamesOnly) console.log(`  ${r.row.field_key.padEnd(38)} → ${r.canon}`);
  }

  const deletions = doomed.length + merges.reduce((n, m) => n + m.drop.length, 0);
  const renames = merges.filter((m) => m.keep.field_key !== m.canon).length + renamesOnly.length;
  console.log(`\nnet: ${rows.length} → ${rows.length - deletions} rows (${deletions} removed, ${renames} renamed to canonical)`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to make these changes.');
    process.exit(0);
  }

  // ── apply ─────────────────────────────────────────────────────────────────────
  if (existsSync(DB)) {
    const backup = `${DB}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(DB, backup);
    console.log(`\nbacked up → ${backup}`);
  }

  for (const d of doomed) await run('DELETE FROM answers WHERE rowid = ?', [d.rowid]);
  for (const r of renamesOnly) {
    await run('UPDATE answers SET field_key = ?, embedding = NULL WHERE rowid = ?', [r.canon, r.row.rowid]);
  }
  for (const m of merges) {
    for (const d of m.drop) await run('DELETE FROM answers WHERE rowid = ?', [d.rowid]);
    if (m.keep.field_key !== m.canon) {
      // Clear the embedding so it is regenerated from the canonical key text.
      await run('UPDATE answers SET field_key = ?, embedding = NULL WHERE rowid = ?', [m.canon, m.keep.rowid]);
    }
  }

  const left = await all('SELECT field_key, value FROM answers ORDER BY field_key');
  console.log(`\n✅ done — ${left.length} rows remain:`);
  for (const r of left) console.log(`   ${r.field_key.padEnd(30)} = ${String(r.value).slice(0, 52)}`);
  console.log('\nEmbeddings for renamed rows were cleared — click "Reindex bank" in the UI to rebuild them.');

}
main();
