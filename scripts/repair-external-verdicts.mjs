// Undo "this job applies on the company site" verdicts that were never true.
//
// LinkedIn stops opening the Easy Apply form once you hit its daily limit, and the old
// detection read that as "external" and wrote it to the database permanently. A day of
// hitting the limit therefore wrote off every LinkedIn job it looked at, including ones
// the scan had positively identified from LinkedIn's own Easy Apply feed.
//
// This clears those verdicts for postings still inside their freshness window, so they
// are checked once more with the detection that can now tell the difference. Older ones
// are left alone: re-checking a posting that has probably expired costs time and teaches
// nothing.
//
// Run: node scripts/repair-external-verdicts.mjs [--go]

import { createRequire } from 'module';

globalThis.require = createRequire(import.meta.url);

const { all, run, get } = await import('../lib/db.js');

const GO = process.argv.includes('--go');
const WINDOW_DAYS = 21;
const cutoff = Date.now() - WINDOW_DAYS * 86400000;

for (const p of await all('SELECT id, name FROM profiles')) {
  const rows = await all(
    `SELECT id, title, apply_kind, discovered_at FROM jobs
      WHERE profile_id = ? AND connector = 'linkedin'
        AND auto_apply_state = 'external'
        AND COALESCE(discovered_at, 0) >= ?`,
    [p.id, cutoff]
  );
  const older = await get(
    `SELECT COUNT(*) n FROM jobs WHERE profile_id = ? AND connector = 'linkedin'
      AND auto_apply_state = 'external' AND COALESCE(discovered_at, 0) < ?`,
    [p.id, cutoff]
  );

  console.log(`\n  ${p.name}`);
  console.log(`    ${rows.length} recent LinkedIn job(s) written off as external — will be re-checked`);
  console.log(`    ${older?.n || 0} older one(s) left alone (past the freshness window)`);

  if (GO && rows.length) {
    await run(
      `UPDATE jobs SET auto_apply_state = NULL, auto_apply_note = NULL, auto_apply_attempts = 0,
                      apply_kind = NULL
        WHERE profile_id = ? AND connector = 'linkedin'
          AND auto_apply_state = 'external' AND COALESCE(discovered_at, 0) >= ?`,
      [p.id, cutoff]
    );
    console.log('    → cleared; the next scan will re-tag any that are really Easy Apply');
  }
}

console.log(GO ? '\n  Done.\n' : '\n  Dry run — nothing changed. Re-run with --go.\n');
process.exit(0);
