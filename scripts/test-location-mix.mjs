// How a batch is composed by location.
//
// Target mix per batch: half at home, a third worldwide, a fifth remote. When a bucket
// is too thin to fill its share, the spare places go to the others in priority order —
// remote, then home, then worldwide.
//
// Worth testing because both halves fail quietly. A bucketing mistake ("Bengaluru
// (Remote)" counted as domestic) silently starves the remote quota, and a quota that
// rounds badly returns nine jobs when you asked for ten.
//
// Run: node scripts/test-location-mix.mjs

import { locationBucket, pickByLocationMix } from '../lib/autoApply.js';

let failed = 0;
const t = (name, cond, detail = '') => {
  if (cond) console.log(`  ok    ${name}`);
  else { failed++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

console.log('\n  which bucket a posting lands in:');
const bucketCases = [
  [{ location: 'Bengaluru, Karnataka, India (Remote)' }, 'remote', 'remote beats geography'],
  [{ location: 'EMEA (Remote)' }, 'remote', ''],
  [{ location: 'Anywhere' }, 'remote', ''],
  [{ location: '', title: 'Backend Engineer (Work From Home)' }, 'remote', 'title counts too'],
  [{ location: 'Noida, Uttar Pradesh, India (Hybrid)' }, 'home', ''],
  [{ location: 'Pune' }, 'home', 'bare home city, no country named'],
  [{ location: 'Kolkata, Mumbai, Hyderabad' }, 'home', ''],
  [{ location: 'Zurich, Switzerland (Hybrid)' }, 'worldwide', ''],
  [{ location: 'Auckland, New Zealand' }, 'worldwide', ''],
  [{ location: 'Dubai, United Arab Emirates (On-site)' }, 'worldwide', ''],
  [{ location: '' }, 'home', 'unlabelled falls to the board\'s own market'],
];
for (const [job, want, why] of bucketCases) {
  const got = locationBucket(job);
  t(`${String(job.location || job.title).slice(0, 42).padEnd(43)} -> ${want}${why ? `  (${why})` : ''}`,
    got === want, `got ${got}`);
}

const make = (bucket, n) => Array.from({ length: n }, (_, i) => ({
  id: `${bucket}-${i}`,
  location: bucket === 'remote' ? 'Remote' : bucket === 'home' ? 'Pune, India' : 'Berlin, Germany',
}));
const countBy = (rows) => rows.reduce((a, r) => {
  const b = locationBucket(r); a[b] = (a[b] || 0) + 1; return a;
}, {});

console.log('\n  a full pool of 10 gets the target mix:');
let got = pickByLocationMix([...make('home', 20), ...make('worldwide', 20), ...make('remote', 20)], 10);
let c = countBy(got);
t('returns exactly 10', got.length === 10, `got ${got.length}`);
t('5 home, 3 worldwide, 2 remote', c.home === 5 && c.worldwide === 3 && c.remote === 2, JSON.stringify(c));

console.log('\n  a thin bucket hands its places to the others, remote first:');
got = pickByLocationMix([...make('home', 20), ...make('worldwide', 1), ...make('remote', 20)], 10);
c = countBy(got);
t('still returns 10', got.length === 10, `got ${got.length}`);
t('the 2 spare worldwide places went to remote', c.remote === 4 && c.worldwide === 1 && c.home === 5,
  JSON.stringify(c));

console.log('\n  no remote and no worldwide at all (Naukri on a normal day):');
got = pickByLocationMix(make('home', 20), 10);
t('fills all 10 from home', got.length === 10 && countBy(got).home === 10, JSON.stringify(countBy(got)));

console.log('\n  a pool smaller than the batch:');
got = pickByLocationMix([...make('home', 2), ...make('remote', 1)], 10);
t('returns everything there is, no duplicates', got.length === 3 && new Set(got.map((r) => r.id)).size === 3,
  `${got.length} rows`);

console.log('\n  odd sizes still add up:');
for (const n of [1, 3, 7, 9, 13, 25]) {
  const rows = pickByLocationMix([...make('home', 30), ...make('worldwide', 30), ...make('remote', 30)], n);
  t(`limit ${String(n).padStart(2)} returns ${String(n).padStart(2)}`, rows.length === n, `got ${rows.length}`);
}

console.log('\n  freshness order is preserved inside each bucket:');
const ordered = Array.from({ length: 10 }, (_, i) => ({ id: `h-${i}`, location: 'Pune, India' }));
got = pickByLocationMix(ordered, 5);
t('takes the first five, in order', got.map((r) => r.id).join(',') === 'h-0,h-1,h-2,h-3,h-4',
  got.map((r) => r.id).join(','));

console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Batch composition is correct');
process.exit(failed ? 1 : 0);
