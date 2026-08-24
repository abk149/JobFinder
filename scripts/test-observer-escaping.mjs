// Guard against the one bug lib/observer.js keeps producing.
//
// The observer is a template literal, so every backslash in it is consumed once by the
// template BEFORE the browser ever sees it. A regex written the ordinary way:
//
//     /\bRequired\b/          in the file
//     /<BS>Required<BS>/      what the page actually receives
//
// `\b` becomes a backspace character, `\s` becomes a plain "s", `\.` becomes ".". The
// result is either a SyntaxError that kills the whole script — every field silently
// stops being detected — or, worse, a regex that still parses and quietly matches the
// wrong thing. Both failures look like "autofill just doesn't work any more", with
// nothing in the logs, which is why this deserves its own check.
//
// Written in the file as `\\s`, `\\b`, `\\.` — doubled — it arrives correct.
//
// Run: node scripts/test-observer-escaping.mjs

import { OBSERVER_SCRIPT } from '../lib/observer.js';

let failed = 0;
const ok = (name) => console.log(`  ok    ${name}`);
const bad = (name, detail) => { failed++; console.log(`  FAIL  ${name}\n        ${detail}`); };

// 1. Control characters are the fingerprint of a collapsed escape. A legitimate script
//    never contains a raw backspace, form-feed or vertical tab.
const traps = { '\b': '\\b', '\f': '\\f', '\v': '\\v' };
const found = [];
for (const [ch, shown] of Object.entries(traps)) {
  let i = OBSERVER_SCRIPT.indexOf(ch);
  while (i !== -1) {
    found.push(`${shown} collapsed to a control character at offset ${i}: …${OBSERVER_SCRIPT.slice(Math.max(0, i - 45), i + 15).replace(/[\b\f\v]/g, '·')}…`);
    i = OBSERVER_SCRIPT.indexOf(ch, i + 1);
  }
}
if (found.length) bad('no collapsed escapes (\\b, \\f, \\v)', found.slice(0, 4).join('\n        '));
else ok('no collapsed escapes (\\b, \\f, \\v)');

// 2. The escapes that collapse SILENTLY — \s becomes "s" with no trace — are caught by
//    asserting the emitted script still carries them.
for (const seq of ['\\s', '\\d', '\\.']) {
  if (OBSERVER_SCRIPT.includes(seq)) ok(`regex escape ${seq} survived into the emitted script`);
  else bad(`regex escape ${seq} survived into the emitted script`, `not present — a "${seq}" in lib/observer.js was written singly and has been eaten by the template literal`);
}

// 3. And the whole thing still has to be valid JavaScript. new Function compiles
//    without running, which is exactly the check we want.
try {
  new Function(OBSERVER_SCRIPT);
  ok('emitted script parses as JavaScript');
} catch (e) {
  bad('emitted script parses as JavaScript', `${e.message} — the page would receive a script that throws on load, so NO fields are ever detected`);
}

// 4. Spot-check the specific patterns auto-apply depends on, so a future edit that
//    removes them is loud rather than silent.
for (const needle of ['collapseRepeat', 'unfilledTargets', '__jobfinderSetByPath', 'opts.root']) {
  if (OBSERVER_SCRIPT.includes(needle)) ok(`still defines ${needle}`);
  else bad(`still defines ${needle}`, 'missing — auto-apply depends on it');
}

console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ Observer escaping is intact');
process.exit(failed ? 1 : 0);
