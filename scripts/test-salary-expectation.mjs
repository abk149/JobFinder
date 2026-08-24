// Salary expectation across currencies.
//
// This decides a number that goes on a real application and is very hard to walk back,
// so every branch is pinned: which fields count as "expected" (not "current"), which
// currency a form is asking for, and what the conversion produces.
//
// Run: node scripts/test-salary-expectation.mjs

import {
  isSalaryExpectationField, detectCurrency, convertExpectation,
  roundExpectation, salaryAnswer, formatAmount,
} from '../lib/salaryExpectation.js';

let failed = 0;
const t = (name, cond, detail = '') => {
  if (cond) console.log(`  ok    ${name}`);
  else { failed++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

const BASE = 3000000;   // ₹30,00,000

console.log('\n  expected vs current — filling one with the other is a real mistake:');
for (const [label, want] of [
  ['Expected CTC', true], ['Salary expectation', true], ['Expected salary (USD)', true],
  ['Desired compensation', true], ['What salary are you seeking?', true],
  ['Current CTC', false], ['Please enter your current ctc in INR', false],
  ['Last drawn salary', false], ['Present salary', false],
  ['Notice period', false], ['Years of experience', false],
]) {
  t(`${label.slice(0, 42).padEnd(43)} -> ${want ? 'expectation' : 'not one'}`,
    isSalaryExpectationField(label) === want);
}

console.log('\n  which currency the form wants:');
for (const [label, job, want, why] of [
  ['Expected CTC in INR', { location: 'Dubai, UAE' }, 'INR', 'label beats location'],
  ['Expected salary (USD)', { location: 'India' }, 'USD', 'label beats location'],
  ['Expected salary in €', {}, 'EUR', 'symbol'],
  ['Expected CTC in lakhs', {}, 'INR', 'lakhs implies rupees'],
  ['Expected salary', { location: 'Zurich, Switzerland' }, 'CHF', 'from location'],
  ['Expected salary', { location: 'Dubai, United Arab Emirates' }, 'AED', 'from location'],
  ['Expected salary', { location: 'Auckland, New Zealand' }, 'NZD', 'from location'],
  ['Expected salary', { location: 'Bengaluru, India' }, 'INR', 'from location'],
  ['Expected salary', { location: 'London, United Kingdom' }, 'GBP', 'from location'],
]) {
  const got = detectCurrency(label, job);
  t(`${label.slice(0, 26).padEnd(27)} @ ${String(job.location || '-').slice(0, 24).padEnd(25)} -> ${want}  (${why})`,
    got?.currency === want, `got ${JSON.stringify(got)}`);
}

console.log('\n  refuses to guess when it genuinely cannot tell:');
t('bare "$" with no country is not enough', detectCurrency('Expected salary in $', {}) === null,
  JSON.stringify(detectCurrency('Expected salary in $', {})));
t('no currency and no location', detectCurrency('Expected salary', {}) === null);
t('a bare $ IS resolved once the country is known',
  detectCurrency('Expected salary in $', { location: 'Singapore' })?.currency === 'SGD');

console.log('\n  purchasing power, not the exchange rate:');
const usd = convertExpectation(BASE, 'INR', 'USD');
t('USD uses purchasing power', usd.ppp === 130000, JSON.stringify(usd));
t('and reports the market figure for contrast', usd.market === 36000, JSON.stringify(usd));
t('the two differ by roughly 3.6x', usd.ratio > 3 && usd.ratio < 4.5, String(usd.ratio));
for (const [cur, want] of [['GBP', 91000], ['EUR', 95000], ['AED', 330000], ['SGD', 110000]]) {
  const c = convertExpectation(BASE, 'INR', cur);
  t(`${cur} -> ${formatAmount(want, cur)}`, c.ppp === want, `got ${c && formatAmount(c.ppp, cur)}`);
}
t('INR to INR is unchanged', convertExpectation(BASE, 'INR', 'INR').ppp === BASE);
t('an unknown currency yields nothing', convertExpectation(BASE, 'INR', 'XYZ') === null);

console.log('\n  rounded to something a person would type:');
for (const [n, cur] of [[129870, 'USD'], [90909, 'GBP'], [3000000, 'INR'], [12345678, 'JPY']]) {
  const r = roundExpectation(n, cur);
  t(`${String(n).padStart(9)} ${cur} -> ${r}`, r % 100 === 0 && Math.abs(r - n) / n < 0.05, String(r));
}

console.log('\n  end to end:');
let a = salaryAnswer('Expected salary', { job: { location: 'Berlin, Germany' }, baseAmount: BASE });
t('a German job gets euros', a?.value === '95000' && a.currency === 'EUR', JSON.stringify(a));
t('and explains itself', /purchasing power/.test(a.why) && /straight exchange/.test(a.why), a.why);

a = salaryAnswer('Expected CTC', { job: { location: 'Pune, India' }, baseAmount: BASE });
t('an Indian job gets the original figure', a?.value === '3000000', JSON.stringify(a));

a = salaryAnswer('Expected salary', { job: {}, baseAmount: BASE });
t('no country: asks rather than guessing', a?.unknownCurrency === true, JSON.stringify(a));

a = salaryAnswer('Expected salary', {
  job: { location: 'New York, United States' }, baseAmount: BASE,
  overrides: { 'expected salary usd': '155000' },
});
t('your own USD figure always wins', a?.value === '155000' && /answer bank/.test(a.why), JSON.stringify(a));

a = salaryAnswer('Current CTC', { job: { location: 'Berlin, Germany' }, baseAmount: BASE });
t('never touches a CURRENT salary field', a === null);

console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Salary conversion is correct');
process.exit(failed ? 1 : 0);
