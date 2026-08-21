// End-to-end test of the EVIDENCE-DRIVEN interview-prep pipeline.
//   job descriptions → validated skills → per-skill research (with URLs) → cited synthesis → ask
// Creates a throwaway profile + jobs, runs the full flow, then cleans up.

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';

process.chdir(path.resolve(import.meta.dirname, '..'));
// lib/db.js uses require() for native drivers; webpack provides it in the app, plain
// Node ESM does not. Shim so the test exercises the real module.
globalThis.require = createRequire(import.meta.url);

const { run, get, all } = await import('../lib/db.js');
const { extractSkillsFromJobs } = await import('../lib/prep/skills.js');
const { researchSkill } = await import('../lib/prep/research.js');
const { buildPrep } = await import('../lib/prep/synthesize.js');
const { askPrep, prepStats } = await import('../lib/prep/kb.js');
const { subscribe } = await import('../lib/logger.js');

const pid = crypto.randomUUID();
const profile = {
  id: pid,
  name: 'Test Candidate',
  keywords: 'backend engineer',
  locations: 'Remote',
  filters: JSON.stringify({ bio: '7 years building payment infrastructure in Go. Led a team of 5 rewriting a ledger service.' }),
};

subscribe(pid, (e) => console.log(`      [${e.level}] ${e.message}`));

console.log('\n=== SETUP ===');
await run(
  'INSERT INTO profiles (id,name,email,resume_path,keywords,locations,filters,created_at) VALUES (?,?,?,?,?,?,?,?)',
  [pid, profile.name, 't@e.dev', '', profile.keywords, profile.locations, profile.filters, Date.now()]
);

// Two JDs with DISTINCT, checkable requirements. The extractor must surface these
// specific technologies — and must NOT surface things absent from the text.
const jobs = [
  {
    title: 'Senior Backend Engineer', company: 'AcmePay',
    desc: 'You will build distributed payment systems. Strong Go required. Experience with Kafka event streams and PostgreSQL at scale is essential. You must design idempotent APIs and own service reliability including SLOs and on-call rotation. Familiarity with distributed tracing is expected.',
  },
  {
    title: 'Staff Platform Engineer', company: 'Northwind',
    desc: 'Lead platform architecture for multi-tenant SaaS. Deep Kubernetes expertise required. You will work with gRPC services, define SLOs, and drive incident response. Strong PostgreSQL knowledge needed. Experience with Terraform for infrastructure as code is a plus.',
  },
];
for (const j of jobs) {
  await run(
    `INSERT INTO jobs (id,profile_id,connector,external_id,title,company,location,url,salary,posted_at,description,raw_json,status,discovered_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [crypto.randomUUID(), pid, 'test', crypto.randomUUID(), j.title, j.company, 'Remote', 'https://example.com/j', '', '', j.desc, '{}', 'new', Date.now()]
  );
}
console.log(`  seeded ${jobs.length} job descriptions`);

const profileRow = await get('SELECT * FROM profiles WHERE id = ?', [pid]);

console.log('\n=== TEST 1: skill extraction is GROUNDED in the JDs ===');
const skills = await extractSkillsFromJobs(profileRow);
console.log(`  extracted ${skills.length} skills:`);
for (const s of skills.slice(0, 12)) {
  console.log(`    ${String(s.count).padStart(2)}×  ${s.skill.padEnd(24)} evidence: ${(s.evidence || '(none)').slice(0, 60)}`);
}

// VALIDATION: the real invariant is that every skill is backed by EVIDENCE — a
// verbatim sentence from a job description. (Checking the canonical skill name
// against the JD would be wrong: the ad says "idempotent"/"at scale" while the
// canonical names are "Idempotency"/"Scalability". The evidence is the proof.)
const allJd = jobs.map((j) => j.desc.toLowerCase().replace(/\s+/g, ' ')).join(' ');
const unevidenced = skills.filter((s) => !s.evidence);
const notInJd = skills.filter(
  (s) => s.evidence && !allJd.includes(s.evidence.toLowerCase().replace(/\s+/g, ' ').slice(0, 40))
);
console.log(`  → skills with no evidence (should be 0): ${unevidenced.length}${unevidenced.length ? ' :: ' + unevidenced.map((b) => b.skill).join(', ') : ''}`);
console.log(`  → evidence not found in any JD (should be 0): ${notInJd.length}${notInJd.length ? ' :: ' + notInJd.map((b) => b.skill).join(', ') : ''}`);
const bogus = [...unevidenced, ...notInJd];

// PostgreSQL and SLOs appear in BOTH ads, so they should rank top.
const top = skills.slice(0, 5).map((s) => s.skill.toLowerCase());
console.log(`  → top-5 skills: ${top.join(', ')}`);

console.log('\n=== TEST 2: per-skill research returns citable URLs ===');
const probe = skills[0]?.skill || 'Kubernetes';
const srcs = await researchSkill(probe, { pid });
console.log(`  "${probe}" → ${srcs.length} sources`);
for (const s of srcs.slice(0, 6)) console.log(`    [${s.kind.padEnd(13)}] ${(s.title || '').slice(0, 46)}  ${s.url.slice(0, 50)}`);
const missingUrl = srcs.filter((s) => !s.url || !/^https?:\/\//.test(s.url)).length;
console.log(`  → sources missing a valid URL (should be 0): ${missingUrl}`);

console.log('\n=== TEST 3: full build (research + cited synthesis) ===');
const t0 = Date.now();
const built = await buildPrep(profileRow, { maxSkills: 2 });
console.log(`  → ${built.notesWritten} note(s), ${built.sourcesStored} sources stored, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log('  skills studied:', built.skills.map((s) => `${s.skill}(${s.count})`).join(', '));

console.log('\n=== TEST 4: notes carry evidence + source links ===');
const notes = await all('SELECT topic, kind, evidence, demand, sources_json, body FROM prep_notes WHERE profile_id = ?', [pid]);
for (const n of notes) {
  if (n.kind === 'daily') { console.log(`\n  [daily] ${n.topic}`); continue; }
  let refs = [];
  try { refs = (JSON.parse(n.sources_json || '{}').references) || []; } catch {}
  console.log(`\n  ── ${n.topic}  (demanded by ${n.demand} ad(s), ${refs.length} refs)`);
  console.log(`     evidence: "${(n.evidence || '(none)').slice(0, 90)}"`);
  for (const r of refs.slice(0, 4)) console.log(`       [${r.n}] ${r.kind}: ${r.url.slice(0, 62)}`);
  const cites = (n.body.match(/\[\d+\]/g) || []).length;
  console.log(`     inline citations in body: ${cites}`);
  console.log(`     body head: ${(n.body || '').split('\n').slice(1, 3).join(' ').slice(0, 150)}`);
}

console.log('\n=== TEST 5: ask the bot ===');
const stats = await prepStats(pid);
console.log('  stats:', JSON.stringify(stats));
const ans = await askPrep(profileRow, `What should I know about ${built.skills[0]?.skill || 'PostgreSQL'} for an interview?`);
console.log(`  grounded: ${ans.grounded} | sources: ${ans.sources.length}`);
console.log('  A:', (ans.answer || '').slice(0, 500));

console.log('\n=== CLEANUP ===');
for (const t of ['prep_chunks', 'prep_notes', 'prep_sources', 'jobs']) {
  await run(`DELETE FROM ${t} WHERE profile_id = ?`, [pid]);
}
await run('DELETE FROM profiles WHERE id = ?', [pid]);
console.log('  removed test data');

const pass =
  skills.length > 0 && bogus.length === 0 && srcs.length > 0 && missingUrl === 0 &&
  built.notesWritten > 0 && built.sourcesStored > 0 && ans.grounded;
console.log('\n=== VERDICT: ' + (pass ? '✅ evidence-driven prep works' : '❌ something failed') + ' ===\n');
process.exit(pass ? 0 : 1);
