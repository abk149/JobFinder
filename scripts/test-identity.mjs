// Personal information must not be able to hold a question's answer.
//
// This is the bug that prompted the split, and it is worth a test because it is silent:
// a form label merely MENTIONING email canonicalised to the `email` key, so
// "Do you consent to email updates? — Yes" was written over the address, and an autofill
// later typed "Yes" into an employer's email box. Nothing complained; to the bank one
// approved string looks like any other.
//
// Run: node scripts/test-identity.mjs

import { createRequire } from 'module';

globalThis.require = createRequire(import.meta.url);

const { canonicalKey } = await import('../lib/answerBank.js');
const { validateIdentity, isIdentityKey, IDENTITY_FIELDS } = await import('../lib/identity.js');

let failed = 0;
const t = (name, cond, detail = '') => {
  if (cond) console.log(`  ok    ${name}`);
  else { failed++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

console.log('\n  a real field keeps its shared key:');
for (const [label, value, want] of [
  ['Email address', 'a@b.com', 'email'],
  ['E-mail ID', 'a.b@c.co.in', 'email'],
  ['Email', 'x@y.org', 'email'],
  ['Phone number', '+44 7700 900123', 'phone'],
  ['Mobile', '7700900123', 'phone'],
  ['LinkedIn Profile URL', 'linkedin.com/in/x', 'linkedin url'],
  ['GitHub', 'github.com/x', 'portfolio url'],
  ['City', 'Bristol', 'city'],
  ['First name', 'Ada', 'first name'],
]) {
  t(`${label.padEnd(22)} = ${String(value).padEnd(22)} -> ${want}`, canonicalKey(label, 'text', value) === want,
    `got ${canonicalKey(label, 'text', value)}`);
}

console.log('\n  a QUESTION that merely mentions one does not:');
for (const [label, value] of [
  ['Do you consent to email updates?', 'Yes'],
  ['Is this your preferred email? Yes/No', 'Yes'],
  ['May we contact you by phone?', 'No'],
  ['Do you have a LinkedIn profile?', 'Yes'],
  ['Are you willing to relocate to another city?', 'Yes'],
  ['Do you have a portfolio?', 'Yes'],
  ['Is your name on the account?', 'Yes'],
]) {
  const got = canonicalKey(label, 'text', value);
  t(`${label.slice(0, 44).padEnd(45)} stays a question`, !isIdentityKey(got), `became "${got}"`);
}

console.log('\n  looking a value up is unaffected (no value passed):');
for (const [label, want] of [['Email address', 'email'], ['Phone', 'phone'], ['City', 'city']]) {
  t(`${label.padEnd(16)} -> ${want}`, canonicalKey(label, 'text') === want, `got ${canonicalKey(label, 'text')}`);
}

console.log('\n  shape checks:');
const cases = [
  ['email', 'work@example.com', true], ['email', 'Yes', false], ['email', 'no-at-sign', false],
  ['email', 'a@b', false],
  ['phone', '+44 7700 900123', true], ['phone', '07700 900123', true], ['phone', 'Yes', false],
  ['phone', '12345', false],
  ['linkedin url', 'www.linkedin.com/in/x', true], ['linkedin url', 'github.com/x', false],
  ['linkedin url', 'Yes', false],
  ['github url', 'github.com/octocat', true], ['github url', 'linkedin.com/in/x', false],
  ['portfolio url', 'mysite.dev', true], ['portfolio url', 'Yes', false],
  ['city', 'Bristol', true], ['city', 'Yes', false], ['city', 'a@b.com', false],
  ['full name', 'Ada Lovelace', true], ['full name', 'Yes', false], ['full name', 'Ada 42', false],
  ['zip code', 'SW1A 1AA', true], ['zip code', 'No', false],
  ['nationality', 'Indian', true], ['nationality', 'N/A', false],
];
for (const [key, value, want] of cases) {
  const got = validateIdentity(key, value).ok;
  t(`${key.padEnd(14)} = ${JSON.stringify(value).padEnd(26)} ${want ? 'accepted' : 'refused '}`, got === want,
    `got ${got ? 'accepted' : 'refused'} (${validateIdentity(key, value).why})`);
}

console.log('\n  every personal field refuses a yes/no:');
for (const f of IDENTITY_FIELDS) {
  const bad = ['Yes', 'No', 'N/A'].every((v) => !validateIdentity(f.key, v).ok);
  t(`${f.label.padEnd(22)} refuses Yes / No / N/A`, bad);
}

console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Personal information is kept separate and checked');
process.exit(failed ? 1 : 0);
