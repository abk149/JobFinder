// The field-key canonicaliser exists twice: once in lib/answerBank.js (Node) and once
// inside the OBSERVER_SCRIPT string in lib/observer.js (injected into pages). The
// observer must stay self-contained, so the list genuinely cannot be imported — but if
// the two ever disagree, the bank silently splits in two: the page writes "linkedin
// url" while the server looks up "linkedin profile", and nothing matches.
//
// This asserts they agree. Run it after touching either list.
//   node scripts/check-canon-parity.mjs

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
globalThis.require = createRequire(import.meta.url);
process.chdir(join(dirname(fileURLToPath(import.meta.url)), '..'));

const { canonicalKey } = await import('../lib/answerBank.js');
const { OBSERVER_SCRIPT } = await import('../lib/observer.js');

// Run the observer's canonical() in a throwaway sandbox by evaluating just its pieces.
const sandbox = new Function(`
  ${OBSERVER_SCRIPT.slice(OBSERVER_SCRIPT.indexOf('  var CANON = ['), OBSERVER_SCRIPT.indexOf('  function labelFor'))}
  return canonical;
`)();

const CASES = [
  ['first name', 'text'], ['given name', 'text'], ['last name', 'text'], ['surname', 'text'],
  ['full name', 'text'], ['candidate name', 'text'], ['your name', 'text'], ['name', 'text'],
  ['linkedin profile', 'text'], ['linkedin url', 'text'], ['please share your linkedin profile', 'text'],
  ['portfolio github', 'url'], ['personal website', 'url'], ['work link online portfolio', 'text'],
  ['candidate email address', 'text'], ['e mail', 'text'], ['anything', 'email'],
  ['candidate phone no', 'text'], ['phone', 'text'], ['mobile number', 'text'], ['anything', 'tel'],
  ['notice period in days', 'text'], ['current annual ctc fixed pay', 'text'],
  ['expected salary', 'text'], ['total years of experience', 'text'], ['years of experience', 'text'],
  ['current company', 'text'], ['current employer', 'text'], ['current designation', 'text'],
  ['current location', 'text'], ['city', 'text'], ['zip postal code', 'text'],
  ['country', 'text'], ['nationality', 'text'], ['citizenship', 'text'],
  ['which project management tools do you use daily', 'textarea'],
  ['describe a time you resolved a challenging onboarding issue', 'textarea'],
];

let bad = 0;
for (const [key, type] of CASES) {
  const node = canonicalKey(key, type);
  const page = sandbox(key, type);
  if (node !== page) {
    bad++;
    console.log(`  ✗ ${JSON.stringify(key)} (${type}): answerBank="${node}" observer="${page}"`);
  }
}

if (bad) {
  console.error(`\n❌ ${bad}/${CASES.length} disagree — the two CANON lists have drifted.`);
  process.exit(1);
}
console.log(`✅ canonicaliser parity holds across ${CASES.length} cases`);
