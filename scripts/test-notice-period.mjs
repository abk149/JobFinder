// Notice period is DERIVED from your last working day, not stored — so it is correct
// today and still correct in six weeks. That makes it arithmetic, and arithmetic on a
// fact an employer will plan around, so it gets a test.
//
// It has already earned it. The "immediate" pattern contained `0\s*day`, which matches
// the "0 day" inside "3-0- days" — so "30 days", "60 days" and "31-60 days" all parsed
// as Immediate, and a 45-day notice period would have been reported to employers as
// "available now". Nothing about that failure is visible from the outside.
//
// Run: node scripts/test-notice-period.mjs

import { derivedAnswer, daysUntil, matchNoticeOption } from '../lib/derivedAnswers.js';
let pass=0,fail=0; const t=(n,c,e='')=>{c?(pass++,console.log('    ok   '+n)):(fail++,console.log('    FAIL '+n+'   '+e));};
// The fixture is built RELATIVE to today, never pinned to a date.
//
// It was pinned once, and the suite went red the first time the clock rolled past
// midnight: daysUntil was given a fixed "now" while derivedAnswer read the real one, so
// the two disagreed by a day. A test for date arithmetic must not itself expire.
const NOW = Date.now();
// Built from LOCAL date parts, not toISOString(). Local midnight east of Greenwich is
// the PREVIOUS day in UTC, so toISOString() silently shifts the date back one and the
// fixture is 44 days out instead of 45 — the same class of bug the code under test
// avoids by parsing "<date>T00:00:00" as local time.
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const in45 = new Date();
in45.setHours(0, 0, 0, 0);
in45.setDate(in45.getDate() + 45);
const LWD = isoLocal(in45);   // 45 days out, whatever today is
const p = { filters: JSON.stringify({ last_working_day: LWD }) };

console.log('\n  days remaining shrink with time:');
t('45 days out', daysUntil(LWD,NOW)===45, String(daysUntil(LWD,NOW)));
t('same date next week is 38', daysUntil(LWD,NOW+7*86400000)===38, String(daysUntil(LWD,NOW+7*86400000)));
t('past dates floor at 0', daysUntil('2020-01-01',NOW)===0);

console.log('\n  which questions it answers:');
t('notice period', derivedAnswer(p,'Notice period (in days)')?.value==='45', JSON.stringify(derivedAnswer(p,'Notice period (in days)')));
t('please enter your notice period in days', derivedAnswer(p,'Please enter your notice period in days')?.value==='45');
t('how soon can you join', derivedAnswer(p,'How soon can you join?')?.value==='45');
t('earliest start DATE gives a date', derivedAnswer(p,'Earliest start date?')?.value===LWD);
t('leaves unrelated questions alone', derivedAnswer(p,'Expected CTC')===null);
t('leaves current CTC alone', derivedAnswer(p,'Please enter your current ctc in INR')===null);
t('nothing without a last working day', derivedAnswer({filters:'{}'},'Notice period')===null);

console.log('\n  dropdown buckets:');
const cases=[
 [45,['Immediate','15 days','30 days','60 days','90 days'],'60 days','rounds UP, never claims sooner'],
 [45,['0-15 days','16-30 days','31-60 days','61-90 days'],'31-60 days','exact bucket'],
 [0, ['Immediate','30 days','60 days'],'Immediate','zero maps to immediate'],
 [45,['1 month','2 months','3 months'],'2 months','months understood'],
 [120,['Immediate','15 days','30 days'],null,'refuses when every option is shorter than the truth'],
 [95,['30 days','60 days','More than 90 days'],'More than 90 days','open-ended bucket'],
];
for(const [d,opts,want,why] of cases){
  const got=matchNoticeOption(d,opts);
  t(`${String(d).padStart(3)}d -> ${JSON.stringify(want)}  (${why})`, got===want, 'got '+JSON.stringify(got));
}
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

