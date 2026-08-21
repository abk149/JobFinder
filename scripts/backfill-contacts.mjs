// Harvest hiring contacts out of job descriptions already in the database.
//
// New scans capture these as they arrive; this recovers what was saved before the
// feature existed. Idempotent — re-running only bumps times_seen.
//
//   node scripts/backfill-contacts.mjs            # dry run
//   node scripts/backfill-contacts.mjs --apply

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
globalThis.require = createRequire(import.meta.url);
process.chdir(join(dirname(fileURLToPath(import.meta.url)), '..'));

const { all } = await import('../lib/db.js');
const { extractContacts, recordContacts } = await import('../lib/contacts.js');

async function main() {
  const APPLY = process.argv.includes('--apply');
  const jobs = await all("SELECT id, profile_id, connector, url, title, company, description FROM jobs WHERE description LIKE '%@%'");
  console.log(`scanning ${jobs.length} job(s) whose text contains an "@"\n`);

  const perProfile = new Map();
  let hits = 0;
  for (const j of jobs) {
    const found = extractContacts(`${j.title || ''}\n${j.description || ''}`, { company: j.company || '' });
    if (!found.length) continue;
    hits += found.length;
    if (!perProfile.has(j.profile_id)) perProfile.set(j.profile_id, []);
    perProfile.get(j.profile_id).push({ job: j, found });
  }

  const distinct = new Set();
  for (const [, entries] of perProfile) for (const e of entries) for (const c of e.found) distinct.add(c.email);
  console.log(`${hits} mention(s) → ${distinct.size} distinct address(es)\n`);

  let shown = 0;
  for (const [, entries] of perProfile) {
    for (const { job, found } of entries) {
      for (const c of found) {
        if (shown++ < 25) {
          console.log(`  ${c.email.padEnd(38)} ${(c.name || '-').padEnd(18)} ${(c.designation || '-').padEnd(20)} ${String(c.company || '-').slice(0, 24)}`);
        }
      }
    }
  }
  if (shown > 25) console.log(`  … and ${shown - 25} more`);

  if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); return; }

  let added = 0, updated = 0;
  for (const [profileId, entries] of perProfile) {
    for (const { job, found } of entries) {
      const r = await recordContacts(profileId, job, found);
      added += r.added; updated += r.updated;
    }
  }
  console.log(`\n✅ ${added} new contact(s), ${updated} updated.`);
}
main();
