// One-time: label every answer as personal information or a question, and quarantine
// anything already stored in the wrong place.
//
// Run: node scripts/split-knowledge-base.mjs [--go]
//
// Nothing is deleted. A personal field holding something that is not a name, address,
// number or link — "Yes" in the email field, which is what prompted this — is emptied
// and turned back into a question, so it appears in the panel for you to fill in rather
// than being typed into an employer's form.

// lib/db.js loads its native driver with a bare require(), which an .mjs entry point
// does not provide. Same shim the other scripts use.
import { createRequire } from 'module';

globalThis.require = createRequire(import.meta.url);

const { all, run } = await import('../lib/db.js');
const { canonicalKey } = await import('../lib/answerBank.js');
const { IDENTITY_FIELDS, isIdentityKey, validateIdentity } = await import('../lib/identity.js');

const GO = process.argv.includes('--go');
const profiles = await all('SELECT id, name FROM profiles');

for (const p of profiles) {
  const rows = await all('SELECT field_key, label, type, value, status, kind FROM answers WHERE profile_id = ?', [p.id]);
  let identity = 0;
  let answers = 0;
  const broken = [];

  for (const r of rows) {
    const isId = isIdentityKey(r.field_key);
    if (isId) {
      identity++;
      const v = validateIdentity(r.field_key, r.value);
      if (String(r.value || '').trim() && !v.ok) broken.push({ ...r, why: v.why });
    } else {
      answers++;
    }
    if (GO) {
      await run('UPDATE answers SET kind = ? WHERE profile_id = ? AND field_key = ?',
        [isId ? 'identity' : 'answer', p.id, r.field_key]);
    }
  }

  console.log(`\n  ${p.name}: ${identity} personal, ${answers} question(s)`);

  // Personal fields that exist in the registry but the bank has never held.
  const have = new Set(rows.map((r) => r.field_key));
  const missing = IDENTITY_FIELDS.filter((f) => !have.has(f.key)).map((f) => f.label);
  if (missing.length) console.log(`    not set yet: ${missing.join(', ')}`);

  // Adopt a value from a duplicate row before asking you to retype it.
  //
  // Before the canonicaliser knew about shapes, "Email Address" and "Email ID" could end
  // up as their own rows alongside `email`. When the personal field is empty and one of
  // those duplicates holds something that IS a valid email, that is the answer — it was
  // captured from a form you filled. Only values that pass the field's own check are
  // adopted, so this cannot reintroduce the problem it is cleaning up after.
  const adopted = [];
  for (const f of IDENTITY_FIELDS) {
    const current = rows.find((r) => r.field_key === f.key);
    const isSet = current && String(current.value || '').trim()
      && current.status !== 'rejected' && current.status !== 'needs_input';
    if (isSet) continue;
    const donor = rows
      .filter((r) => r.field_key !== f.key && String(r.value || '').trim())
      .filter((r) => canonicalKey(r.label || r.field_key, r.type, r.value) === f.key)
      .find((r) => validateIdentity(f.key, r.value).ok);
    if (!donor) continue;
    adopted.push({ key: f.key, from: donor.field_key, value: donor.value });
    if (GO) {
      await run(
        `INSERT INTO answers (profile_id, field_key, label, value, type, last_seen, hit_count, status, source, kind)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(profile_id, field_key) DO UPDATE
           SET value = excluded.value, status = 'approved', kind = 'identity'`,
        [p.id, f.key, f.label, donor.value, 'text', Date.now(), 1, 'approved', 'adopted', 'identity']
      );
    }
  }
  if (adopted.length) {
    console.log(`    ${adopted.length} personal field(s) recovered from duplicate rows:`);
    for (const a of adopted) console.log(`      ${a.key.padEnd(16)} <- "${a.from}"  =  ${JSON.stringify(String(a.value).slice(0, 34))}`);
  }

  if (broken.length) {
    console.log(`    ${broken.length} personal field(s) holding something that does not belong:`);
    for (const b of broken) {
      console.log(`      ${b.field_key.padEnd(16)} = ${JSON.stringify(String(b.value).slice(0, 30)).padEnd(24)} ${b.why}`);
      if (GO) {
        await run(
          "UPDATE answers SET value = '', status = 'needs_input', kind = 'identity' WHERE profile_id = ? AND field_key = ?",
          [p.id, b.field_key]
        );
      }
    }
    if (GO) console.log('    → emptied and queued for you to re-enter');
  } else {
    console.log('    every personal field holds something plausible');
  }
}

console.log(GO ? '\n  Done.\n' : '\n  Dry run — nothing changed. Re-run with --go.\n');
process.exit(0);
