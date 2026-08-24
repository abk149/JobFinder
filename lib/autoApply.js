// Auto-apply: complete LinkedIn Easy Apply and Naukri on-site applications end to end.
//
// This is the only part of JobFinder that presses a button an employer sees. Everything
// here is shaped by that one fact.
//
// THE RULE THAT DECIDES EVERYTHING
// If the form asks something the answer bank cannot answer, we STOP. We do not let the
// LLM invent a reply. A drafted paragraph about why you want the job is a writing task
// and the model is good at it; "how many years of Kubernetes do you have" is a fact
// about you, and a model that has never met you cannot supply it. Getting that wrong is
// not a cosmetic bug — it is a false statement on a real application, sent under your
// name, that you cannot retract.
//
// So unanswerable questions are parked in the answer bank with status 'needs_input'
// (see parkQuestion), the application is abandoned before submitting, and the job is
// left to be retried. Answer the question once and every job blocked on it unblocks,
// because questions are keyed by field_key exactly like ordinary answers.
//
// TWO SITES, TWO DIFFERENT DANGERS
//   LinkedIn — a multi-step wizard. Safe to walk through; nothing is sent until the
//     final "Submit application". We can fill, inspect, screenshot, and back out.
//   Naukri  — clicking "Apply" IS the submission. There is no review step to stop at.
//     So on Naukri a dry run must not click at all; it reports what it would do.
//
// DRY RUN IS THE DEFAULT
// armed=false fills everything, screenshots the completed form and stops. You look at
// the screenshots, and only then arm it. The first time this runs against a real
// employer should not also be the first time anyone has seen its output.

import fs from 'node:fs';
import path from 'node:path';
import { get, run, all } from './db.js';
import { getContext } from './browser.js';
import { retrieve } from './knowledge.js';
import { answersAsMap, parkQuestion, canonicalKey } from './answerBank.js';
import { linfo, lok, lwarn, lerr } from './logger.js';

// Same bar autofill uses for filling a field verbatim from the bank. Deliberately not
// lowered for auto-apply: this path has less human oversight, not more.
const SEMANTIC_CONFIDENT = 0.55;

// A wizard that has not finished in this many steps is not a wizard we understand.
const MAX_STEPS = 12;

// Buttons that send the application. Matched defensively and never clicked unless
// armed — an unexpected label here is the difference between a dry run and 10 live
// applications.
const SUBMIT_RE = /^(submit application|submit|send application)$/i;
const ADVANCE_RE = /^(continue to next step|next|review your application|review|continue)$/i;

/**
 * page.evaluate that survives a navigation.
 *
 * These flows navigate under us constantly — following the apply link, pressing Next,
 * the SPA swapping routes — and any evaluate in flight when that happens throws
 * "Execution context was destroyed". Every read here is best-effort by nature, so a
 * torn-down context should yield the fallback, not abort an application mid-way.
 */
async function safeEval(page, fn, arg, fallback = null) {
  try {
    return await page.evaluate(fn, arg);
  } catch { return fallback; }
}

export function shotDir(profileId) {
  const dir = path.join(process.cwd(), 'data', 'applications', profileId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function shoot(page, profileId, jobId, tag) {
  try {
    const file = path.join(shotDir(profileId), `${jobId}-${tag}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch { return null; }
}

/** LinkedIn job ids are the long number in any of its many URL shapes. */
export function linkedinJobId(url = '') {
  const m = String(url).match(/(?:jobs\/view\/|currentJobId=)[^0-9]*(\d{6,})/) || String(url).match(/(\d{9,})/);
  return m ? m[1] : null;
}

/**
 * Decide what an answer for this field should be, using ONLY the answer bank.
 *
 * Returns { value } when we know it, or { missing: true } when we do not. There is
 * deliberately no third branch that asks an LLM — see the note at the top of the file.
 *
 * For a dropdown the value additionally has to BE one of the offered options, so a
 * known answer that does not match any choice is treated as unknown rather than
 * jammed in: setting a <select> to a value it does not have silently sets nothing.
 */
export async function resolveAnswer(profile, target, exactMap) {
  const key = canonicalKey(target.key || target.label, target.type);
  let value = key ? exactMap[key] : null;

  if (!value) {
    try {
      const { hits, exact } = await retrieve(profile, target.label || target.key, { k: 4 });
      if (exact?.value) value = exact.value;
      else if (hits[0] && hits[0].score >= SEMANTIC_CONFIDENT) value = hits[0].value;
    } catch { /* retrieval offline — treat as unknown, never as "fill anything" */ }
  }
  if (!value) return { missing: true };

  if (target.options && target.options.length) {
    const real = target.options.filter(
      (o) => o && !/^(select|please select|please choose|choose)\b/i.test(o.trim()) && !/^-+/.test(o.trim())
    );
    if (!real.length) return { missing: true, reason: 'no-option-match', have: String(value).slice(0, 60) };
    target = { ...target, options: real };
    const want = String(value).trim().toLowerCase();
    const hit = target.options.find((o) => o.trim().toLowerCase() === want)
      || target.options.find((o) => o.trim().toLowerCase().includes(want))
      || (/^(yes|no)$/i.test(want)
        ? target.options.find((o) => o.trim().toLowerCase() === want)
        : null);
    // We DO have an answer, it just is not one of the offered choices — a city for a
    // dropdown listing only other cities, or "3 years" where the options are ranges.
    // Flagged distinctly so the caller re-parks it WITH the choices attached; treating
    // it as ordinary "missing" makes parkQuestion refuse it as already-known and the
    // question then never reaches you, while the run keeps reporting it as blocking.
    if (!hit) return { missing: true, reason: 'no-option-match', have: String(value).slice(0, 60) };
    return { value: hit };
  }
  return { value };
}

/**
 * A fingerprint of the current wizard step.
 *
 * LinkedIn does not tell you it refused to advance. If a required field is empty it
 * simply does nothing when you press Next — same dialog, same percentage, no error we
 * can see. Comparing this before and after the click is the only reliable way to know
 * whether anything happened.
 */
async function stepSignature(page, rootSelector) {
  try {
    return await page.evaluate(({ root }) => {
      const d = document.querySelector(root);
      if (!d) return 'gone';
      const pct = (d.innerText.match(/(\d+)%/) || [])[0] || '';
      const names = [...d.querySelectorAll('input,select,textarea')]
        .filter((e) => e.type !== 'hidden').map((e) => e.id || e.name || e.type).join(',');
      return `${pct}|${names}`;
    }, { root: rootSelector });
  } catch { return 'err'; }
}

/** Read the visible fields inside `rootSelector` using the injected observer. */
async function scanFields(page, rootSelector) {
  try {
    return await page.evaluate(
      ({ root }) => (window.__jobfinderFill ? window.__jobfinderFill({}, { root, overwrite: false }) : null),
      { root: rootSelector }
    );
  } catch { return null; }
}

// Write one field through the observer's setter, which re-validates at write time —
// the same guard ordinary autofill relies on, and the reason a value never lands in
// the wrong box when a framework re-renders the form between scan and write.
async function setField(page, target, value) {
  try {
    return await page.evaluate(
    ({ sel, fallback, val }) => {
      if (!window.__jobfinderSetByPath) return { ok: false, reason: 'setter missing' };
      const r = window.__jobfinderSetByPath(sel, val);
      if (r && r.ok) return r;
      // The token selector is stamped at scan time; if the element was re-created since,
      // fall back to the structural path before giving up.
      return fallback ? window.__jobfinderSetByPath(fallback, val) : r;
    },
      { sel: target.selector, fallback: target.fallbackSelector, val: value }
    );
  } catch (e) { return { ok: false, reason: String(e?.message || e).slice(0, 60) }; }
}

/**
 * Fill a field and CONFIRM it took.
 *
 * Writing .value is enough for an ordinary input, and wrong for a typeahead. LinkedIn's
 * "Location (city)" is an autocomplete: it keeps its real answer in React state, which
 * only updates from genuine keystrokes plus a chosen suggestion. Write to it directly
 * and the box shows your text while the form still considers it empty — so Next does
 * nothing, forever, with no error. That is a silent failure the earlier loop could not
 * distinguish from "no button here", so it is checked explicitly.
 *
 * Returns { ok } — and ok means the value is actually in the field afterwards, not
 * merely that a write was attempted.
 */
async function fillAndVerify(page, target, value) {
  const isTypeahead = /typeahead/i.test(target.selector || '')
    || /typeahead/i.test(target.fallbackSelector || '')
    || await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      return el.getAttribute('role') === 'combobox'
        || !!el.getAttribute('aria-autocomplete')
        || /typeahead/i.test(el.id || '');
    }, target.selector).catch(() => false);

  // A <select> is set through Playwright, not through a synthetic change event.
  //
  // LinkedIn's dropdowns are React-controlled: assigning selectedIndex and dispatching
  // change updates what the box SHOWS while React's own state stays on the placeholder,
  // so the step keeps failing validation and Next silently does nothing. selectOption
  // drives it the way a person does, and the component actually registers the choice.
  const isSelect = target.type === 'select'
    || await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return !!el && el.tagName === 'SELECT';
    }, target.selector).catch(() => false);

  if (isSelect) {
    try {
      const loc = page.locator(target.selector).first();
      await loc.selectOption({ label: String(value) }, { timeout: 8000 });
      await page.waitForTimeout(400);
      const now = await safeEval(page, (sel) => {
        const el = document.querySelector(sel);
        const o = el && el.options ? el.options[el.selectedIndex] : null;
        return o ? (o.text || '').trim() : '';
      }, target.selector, '');
      return { ok: now.toLowerCase() === String(value).trim().toLowerCase(), how: 'select', reason: now ? `shows "${now}"` : 'no option selected' };
    } catch (e) {
      return { ok: false, reason: `selectOption failed: ${String(e?.message || e).slice(0, 60)}` };
    }
  }

  if (!isTypeahead) {
    const r = await setField(page, target, value);
    const stuck = await page.evaluate(
      ({ sel, val }) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const want = String(val).trim().toLowerCase();
        // A <select> is confirmed by its SELECTED OPTION, not by .value. LinkedIn's
        // option values are URNs while the visible text is "1 year", so comparing
        // .value to what we asked for reports failure on a dropdown that is set
        // perfectly well — and the run then blames a field that is actually fine.
        if (el.tagName === 'SELECT') {
          const o = el.options[el.selectedIndex];
          return !!o && (o.text.trim().toLowerCase() === want || String(o.value).trim().toLowerCase() === want);
        }
        return String(el.value || '').trim() === String(val).trim();
      }, { sel: target.selector, val: value }
    ).catch(() => false);
    if (stuck) return { ok: true, how: 'direct' };
    if (r?.ok && !stuck) return { ok: false, reason: 'value did not stick' };
    return r || { ok: false };
  }

  // Typeahead: type it like a person, then take the suggestion the site offers.
  try {
    const loc = page.locator(target.selector).first();
    await loc.click({ timeout: 8000 });
    await loc.fill('');
    await loc.pressSequentially(String(value).slice(0, 60), { delay: 90 });
    await page.waitForTimeout(1600);
    const opt = page.locator('[role="option"], [role="listbox"] li').first();
    if (await opt.count().catch(() => 0)) {
      await opt.click({ timeout: 5000 });
    } else {
      await loc.press('ArrowDown');
      await loc.press('Enter');
    }
    await page.waitForTimeout(600);
    const filled = await safeEval(page, (sel) => {
      const el = document.querySelector(sel);
      return !!el && !!String(el.value || '').trim();
    }, target.selector, false);
    return { ok: filled, how: 'typeahead', reason: filled ? undefined : 'no suggestion accepted' };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 80) };
  }
}

/**
 * Ask the FORM why it refused, instead of guessing.
 *
 * When a step will not advance, the site almost always says why — an inline error under
 * the offending field, and aria-invalid on the control. Reading that is far better than
 * inferring, because it distinguishes the two cases that look identical from outside:
 * a field we left empty, and a field we filled with something the site rejects (a
 * stored answer that is the wrong shape, like a plain word where a URL is required).
 *
 * The second case matters: the answer bank HAS an answer, so nothing looks missing, and
 * without this the run would report "everything is answered" while the form disagrees.
 */
async function validationErrors(page, rootSelector) {
  try {
    return await page.evaluate(({ root }) => {
      const d = document.querySelector(root);
      if (!d) return [];
      // Same doubled-label problem the observer has: a visible <label> plus an
      // aria-label on the same control concatenate into "Total years Total years",
      // which becomes a key nothing else ever matches. Collapse it here too — this
      // walker is independent of the observer's, so it needs its own copy.
      const collapse = (str) => {
        const w = String(str || '').trim().split(/\s+/);
        if (w.length < 4) return String(str || '').trim();
        for (let k = w.length - 2; k >= 2; k--) {
          const head = w.slice(0, k).join(' ');
          const tw = w.slice(k);
          if (tw.length < 2) continue;
          const tail = tw.join(' ');
          if (head.length >= tail.length && head.toLowerCase().indexOf(tail.toLowerCase()) === 0) return head;
        }
        return w.join(' ');
      };
      const labelFor = (el) => {
        if (el.id) {
          const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (l && l.innerText.trim()) return collapse(l.innerText.replace(/\s+/g, ' ').trim());
        }
        const al = el.getAttribute('aria-label');
        if (al) return collapse(al.trim());
        let n = el.parentElement;
        for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
          const t = (n.innerText || '').replace(/\s+/g, ' ').trim();
          if (t && t.length < 140) return collapse(t);
        }
        return '';
      };
      const out = [];
      d.querySelectorAll('input,select,textarea').forEach((el) => {
        if (el.type === 'hidden') return;
        const invalid = el.getAttribute('aria-invalid') === 'true';
        // The error node is usually described by aria-describedby, or sits alongside.
        let msg = '';
        const desc = el.getAttribute('aria-describedby');
        if (desc) {
          desc.split(/\s+/).forEach((idr) => {
            const n = document.getElementById(idr);
            const t = n && (n.innerText || '').trim();
            if (t && /required|valid|enter|select|must/i.test(t)) msg = t.replace(/\s+/g, ' ').slice(0, 120);
          });
        }
        if (!invalid && !msg) return;
        // If it is a dropdown, carry the choices out with it. A question that reaches
        // you as "pick one" without saying what the options are is unanswerable, and
        // any value you type that is not on the list will be rejected again — which is
        // exactly the loop this is here to break.
        let options = null;
        if (el.tagName === 'SELECT') {
          options = [...el.options]
            .map((o) => (o.text || '').trim())
            // Drop the "Select an option" prompt — it is not an answer, and a form set
            // to it stays invalid while appearing filled.
            .filter((o) => o && !/^(select|please select|please choose|choose)\b/i.test(o) && !/^-+/.test(o))
            .slice(0, 60);
        }
        out.push({
          // The scan stamps data-jf-target on every field it offered. Carrying it out
          // here lets the caller recover the SAME key the scan used, instead of
          // deriving a second one from a different label walker — two keys for one
          // question means you answer it under one and the run keeps asking under the
          // other, forever.
          token: el.getAttribute('data-jf-target') || '',
          label: labelFor(el).slice(0, 90),
          value: String(el.value || '').slice(0, 40),
          error: msg || 'marked invalid',
          id: el.id || '',
          options,
        });
      });
      return out;
    }, { root: rootSelector });
  } catch { return []; }
}

/** The buttons currently offered by the apply dialog, in DOM order. */
async function dialogButtons(page, rootSelector) {
  try {
    return await page.evaluate(({ root }) => {
      const scope = (root && document.querySelector(root)) || document;
      return [...scope.querySelectorAll('button')]
        .filter((b) => !b.disabled && (b.offsetWidth || b.offsetHeight))
        .map((b) => ({
          text: (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
          aria: (b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
        }))
        .filter((b) => b.text);
    }, { root: rootSelector });
  } catch { return []; }
}

// Every DOM call here can land mid-navigation — clicking Next or Submit tears the
// execution context down under us, and Playwright turns that into a thrown error that
// would abort the whole job. These are all best-effort by nature, so a destroyed
// context means "could not do it", not "crash the run".
async function clickByText(page, rootSelector, re) {
  try {
    return await page.evaluate(({ root, src, flags }) => {
      const rx = new RegExp(src, flags);
      const scope = (root && document.querySelector(root)) || document;
      const b = [...scope.querySelectorAll('button')]
        .filter((x) => !x.disabled && (x.offsetWidth || x.offsetHeight))
        .find((x) => rx.test((x.innerText || x.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()));
      if (!b) return false;
      b.click();
      return true;
    }, { root: rootSelector, src: re.source, flags: re.flags });
  } catch { return false; }
}

// ── LinkedIn ────────────────────────────────────────────────────────────────
//
// LinkedIn replaced the old `.jobs-easy-apply-modal` with a server-driven flow whose
// class names are build hashes (`bb9bff38 _7917aabf …`), so nothing here keys off a
// class. It keys off role="dialog", visible button text, and the form-element id
// prefixes that survived the rewrite. Easy Apply is also an <a>, not a <button>.
const LI_DIALOG = 'div[role="dialog"]';

async function linkedinApply(page, profile, job, { armed, exactMap, pid }) {
  const id = linkedinJobId(job.url);
  if (!id) return { state: 'skipped', note: 'no LinkedIn job id in the URL' };

  await page.goto(`https://www.linkedin.com/jobs/view/${id}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);

  const state = await safeEval(page, () => {
    const t = document.body.innerText || '';
    if (/you('|’)?ve applied|application submitted/i.test(t.slice(0, 4000))) return 'already';
    const el = [...document.querySelectorAll('a,button')].find((e) => /easy apply/i.test(e.innerText || ''));
    return el ? 'easy' : 'external';
  }, undefined, 'external');
  if (state === 'already') return { state: 'already_applied', note: 'LinkedIn says you have already applied' };
  if (state === 'external') return { state: 'external', note: 'Not an Easy Apply job — applies on the company site' };

  // Navigate to the apply flow rather than clicking the button.
  //
  // Easy Apply is an <a href=".../apply/?openSDUIApplyFlow=true">, and clicking it in
  // an automated context does nothing observable — the SPA swallows the event and the
  // URL never changes, which is what made the first version of this report "no submit
  // button" on every job. Following the href opens the same dialog deterministically.
  const href = await safeEval(page, () => {
    const el = [...document.querySelectorAll('a')].find((e) => /easy apply/i.test(e.innerText || ''));
    return el ? el.getAttribute('href') : null;
  }, undefined, null);
  const applyUrl = href
    ? new URL(href, 'https://www.linkedin.com').toString()
    : `https://www.linkedin.com/jobs/view/${id}/apply/?openSDUIApplyFlow=true`;
  await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

  try {
    await page.waitForSelector(LI_DIALOG, { timeout: 20000 });
  } catch {
    // Say where we ended up. LinkedIn bounces expired postings to the job search, and
    // "dialog did not open" gives you no way to tell that from a genuine failure.
    const at = page.url();
    if (!/\/jobs\/view\//.test(at)) {
      return { state: 'expired', note: `Posting is gone — LinkedIn redirected to ${at.slice(0, 70)}` };
    }
    return { state: 'error', note: 'Easy Apply dialog did not open (LinkedIn may have changed the flow)' };
  }

  const missing = [];
  const unwritable = [];   // answers we have, but the widget would not accept
  // Keys we actually wrote a stored answer into during this run. Only these may have
  // that stored answer invalidated by a later validation error — see below.
  const attempted = new Set();
  let submitted = false;
  let lastShot = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    await page.waitForTimeout(1200);

    // Scan and fill REPEATEDLY within one step, not once.
    //
    // These forms are conditional: answering "do you have experience with X" makes the
    // follow-up "how many years of X" appear, and it appears only after the first
    // answer lands. A single scan therefore misses every second-order field — they were
    // not in the DOM when we looked. The step then refuses to advance and the only
    // evidence is a validation error on a field we never even saw, which is what made
    // this look like "the form rejects answers we have".
    const targets = [];
    const seenKeys = new Set();
    for (let pass = 0; pass < 4; pass++) {
      const scan = await scanFields(page, LI_DIALOG);
      const fresh = (scan?.unfilledTargets || []).filter((t) => !seenKeys.has(t.key));
      if (process.env.JOBFINDER_AUTOAPPLY_DEBUG === '1') {
        linfo(pid, `      · step ${step} pass ${pass}: ${(scan?.unfilledTargets || []).length} unfilled, ${(scan?.prefilled || []).length} prefilled, ${fresh.length} new`
          + (fresh.length ? ` → ${fresh.map((t) => t.label).join(' ; ').slice(0, 160)}` : ''));
      }
      if (!fresh.length) break;
      for (const t of fresh) { seenKeys.add(t.key); targets.push(t); }
      await fillTargets(fresh);
      await page.waitForTimeout(1100);   // let conditional fields render
    }

    async function fillTargets(list) {
    for (const t of list) {
      const r = await resolveAnswer(profile, t, exactMap);
      if (r.missing) {
        // Optional questions are not worth stopping an application for.
        if (!t.required) { linfo(pid, `      – skipped optional "${t.label}"`); continue; }
        missing.push({
          field_key: canonicalKey(t.key || t.label, t.type),
          label: r.reason === 'no-option-match'
            ? `${t.label} — your saved answer "${r.have}" is not one of the choices`
            : t.label,
          type: t.type,
          options: t.options,
          replace: r.reason === 'no-option-match',
        });
        continue;
      }
      const w = await fillAndVerify(page, t, r.value);
      if (w?.ok) {
        attempted.add(canonicalKey(t.key || t.label, t.type));
        linfo(pid, `      ✓ ${t.label} → ${String(r.value).slice(0, 40)}`);
      } else if (t.required) {
        // We knew the answer but could not get it into the field. Treating that as
        // "done" is what made the wizard press Next forever.
        lwarn(pid, `      ⚠ ${t.label}: could not set "${String(r.value).slice(0, 30)}" (${w?.reason || 'unknown'})`);
        unwritable.push({ label: t.label, value: r.value, reason: w?.reason || 'unknown' });
      }
    }
    }

    if (missing.length) break;   // never advance a form we cannot complete

    const buttons = await dialogButtons(page, LI_DIALOG);
    const hasSubmit = buttons.some((b) => SUBMIT_RE.test(b.text) || SUBMIT_RE.test(b.aria));

    if (hasSubmit) {
      lastShot = await shoot(page, profile.id, job.id, 'final');
      if (!armed) {
        return { state: 'dry_run', note: 'Filled and ready to submit — stopped because auto-apply is not armed', shot: lastShot };
      }
      const ok = await clickByText(page, LI_DIALOG, SUBMIT_RE);
      if (!ok) return { state: 'error', note: 'Submit button vanished before it could be clicked', shot: lastShot };
      await page.waitForTimeout(4000);
      submitted = true;
      break;
    }

    const before = await stepSignature(page, LI_DIALOG);
    const advanced = await clickByText(page, LI_DIALOG, ADVANCE_RE);
    if (!advanced) {
      lastShot = await shoot(page, profile.id, job.id, `stuck-step${step}`);
      return { state: 'error', note: `No next/submit button at step ${step + 1} — buttons were: ${buttons.map((b) => b.text).join(' | ').slice(0, 120)}`, shot: lastShot };
    }
    await page.waitForTimeout(2000);

    // Did pressing Next actually do anything?
    //
    // If not, the form refused — and the only reason it refuses is a required answer
    // it does not have. LinkedIn frequently omits `required` and `aria-required` on
    // these custom widgets, so the field looked optional and got skipped. The refusal
    // IS the requirement signal, so anything still unanswered on this step gets parked
    // rather than skipped. Without this the wizard just presses Next twelve times and
    // reports nothing useful.
    if ((await stepSignature(page, LI_DIALOG)) === before) {
      for (const t of targets) {
        const r = await resolveAnswer(profile, t, exactMap);
        if (!r.missing) continue;
        const fk = canonicalKey(t.key || t.label, t.type);
        if (fk && !missing.some((m) => m.field_key === fk)) {
          missing.push({ field_key: fk, label: t.label, type: t.type, options: t.options });
        }
      }
      // Nothing was unanswered, so ask the form what it objects to.
      if (!missing.length) {
        const errs = await validationErrors(page, LI_DIALOG);
        for (const e of errs) {
          // Prefer the key the scan already used for this exact element.
          const scanned = e.token
            ? targets.find((t) => (t.selector || '').includes(`"${e.token}"`))
            : null;
          const fk = scanned
            ? canonicalKey(scanned.key || scanned.label, scanned.type)
            : canonicalKey(e.label, 'text');
          if (!fk || missing.some((m) => m.field_key === fk)) continue;
          missing.push({
            field_key: fk,
            label: e.value
              ? `${e.label} — the site rejected "${e.value}" (${e.error})`
              : `${e.label} (${e.error})`,
            type: e.options ? 'select' : 'text',
            options: e.options,
            // Only invalidate a stored answer we actually TRIED this run.
            //
            // A field flagged invalid that we never wrote to is simply an empty
            // required field — not evidence that your saved answer is wrong. Re-parking
            // it unconditionally flips an answered row back to needs_input, where
            // retrieval cannot see it, so the next run cannot answer it either and
            // parks it again. That loop makes a question permanently unanswerable: you
            // fill it in, and the run quietly undoes that every time.
            replace: attempted.has(fk),
          });
        }
      }
      if (!missing.length) {
        lastShot = await shoot(page, profile.id, job.id, `refused-step${step}`);
        const why = unwritable.length
          ? `could not set: ${unwritable.map((u) => `${u.label} (${u.reason})`).join(', ').slice(0, 140)}`
          : 'the form gave no reason and every field on it is answered';
        return { state: 'error', note: `The form would not advance past step ${step + 1} — ${why}`, shot: lastShot };
      }
      break;
    }
  }

  if (missing.length) {
    lastShot = await shoot(page, profile.id, job.id, 'blocked');
    return { state: 'needs_input', note: `${missing.length} question(s) I cannot answer`, missing, shot: lastShot };
  }
  if (!submitted) return { state: 'error', note: `Wizard did not reach a submit step in ${MAX_STEPS} steps`, shot: lastShot };

  const confirmed = await safeEval(page, () =>
    /application sent|your application was sent|application submitted/i.test(document.body.innerText.slice(0, 3000)),
  undefined, false);
  return {
    state: 'applied',
    note: confirmed ? 'Submitted — LinkedIn confirmed it was sent' : 'Submitted (no confirmation text seen)',
    shot: await shoot(page, profile.id, job.id, 'submitted'),
  };
}

// ── Naukri ──────────────────────────────────────────────────────────────────
//
// Naukri distinguishes the two apply types by button id, which is the cleanest signal
// either site gives us:
//     #apply-button         applies on Naukri  — what we can automate
//     #company-site-button  redirects to the employer — not ours to drive
//
// The danger here is that #apply-button has no review step. Clicking it sends the
// application, and for some jobs it then opens a chatbot that asks follow-up questions
// AFTER you are already in. So a dry run does not click it at all.
async function naukriApply(page, profile, job, { armed, exactMap, pid }) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);

  const kind = await safeEval(page, () => {
    // An expired listing does not 404 — Naukri quietly redirects to a SEARCH page for
    // similar roles. Every apply selector then misses, and the honest report is "this
    // job is gone", not "no apply button found", which reads like our bug.
    if (!/\/job-listings-/.test(location.href) || /\?expJD=|-jobs-in-/.test(location.href)) return 'expired';
    const t = document.body.innerText || '';
    if (/\bapplied\b/i.test(t.slice(0, 3000))) return 'already';
    if (document.querySelector('#apply-button')) return 'internal';
    if (document.querySelector('#company-site-button')) return 'external';
    return 'none';
  }, undefined, 'none');

  if (kind === 'expired') return { state: 'expired', note: 'Listing is gone — Naukri redirected to search results' };
  if (kind === 'already') return { state: 'already_applied', note: 'Naukri says you have already applied' };
  if (kind === 'external') return { state: 'external', note: 'Naukri "Apply on company site" — external redirect' };
  if (kind === 'none') return { state: 'error', note: 'No apply button found on the page' };

  if (!armed) {
    return {
      state: 'dry_run',
      note: 'Naukri applies the moment the button is clicked, so a dry run stops here',
      shot: await shoot(page, profile.id, job.id, 'before-apply'),
    };
  }

  await page.click('#apply-button').catch(() => {});
  await page.waitForTimeout(4000);

  // Some jobs open a chatbot with extra questions once you are in.
  const chat = '.chatbot_DrawerContentWrapper, .chatbot_Drawer, [class*="chatbot"]';
  const missing = [];
  if (await page.$(chat)) {
    for (let step = 0; step < MAX_STEPS; step++) {
      await page.waitForTimeout(1500);
      const scan = await scanFields(page, chat);
      const targets = scan?.unfilledTargets || [];
      if (!targets.length) break;
      let wrote = false;
      for (const t of targets) {
        const r = await resolveAnswer(profile, t, exactMap);
        if (r.missing) {
          missing.push({ field_key: canonicalKey(t.key || t.label, t.type), label: t.label, type: t.type, options: t.options });
          continue;
        }
        const w = await setField(page, t, r.value);
        if (w?.ok) { wrote = true; linfo(pid, `      ✓ ${t.label} → ${String(r.value).slice(0, 40)}`); }
      }
      if (missing.length) break;
      if (!wrote) break;
      await clickByText(page, chat, /^(save|next|submit|continue)$/i);
    }
  }

  const shot = await shoot(page, profile.id, job.id, 'after-apply');
  if (missing.length) {
    // The application is already in — Naukri sent it on click. Say so plainly rather
    // than implying it was held back.
    return { state: 'applied_incomplete', note: `Applied, but the follow-up chatbot asked ${missing.length} question(s) I could not answer`, missing, shot };
  }
  const ok = await safeEval(page, () => /applied|application sent/i.test(document.body.innerText.slice(0, 3000)), undefined, false);
  return { state: 'applied', note: ok ? 'Applied on Naukri' : 'Apply clicked (no confirmation text seen)', shot };
}

/** Apply to one job. Never throws — a bad job must not stop the run. */
export async function autoApplyJob(ctx, profile, job, { armed = false } = {}) {
  const pid = profile.id;
  const page = await ctx.newPage();
  try {
    const exactMap = await answersAsMap(pid);
    const fn = job.connector === 'linkedin' ? linkedinApply
      : job.connector === 'naukri' ? naukriApply
        : null;
    if (!fn) return { state: 'unsupported', note: `${job.connector} has no on-site apply flow` };
    return await fn(page, profile, job, { armed, exactMap, pid });
  } catch (e) {
    return { state: 'error', note: String(e?.message || e).slice(0, 200) };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Jobs worth trying: on-site-applyable connectors, not already applied or exhausted. */
export async function eligibleJobs(profileId, limit) {
  return all(
    `SELECT * FROM jobs
      WHERE profile_id = ?
        AND connector IN ('linkedin','naukri')
        AND status IN ('new','shortlisted','in_progress')
        AND (auto_apply_state IS NULL
             OR auto_apply_state IN ('dry_run','needs_input','error'))
      ORDER BY COALESCE(fit_score, 0) DESC, discovered_at DESC
      LIMIT ?`,
    [profileId, limit]
  );
}

/**
 * Run a batch.
 *
 * The cap is not a formality. Both sites rate-limit applications and both treat a
 * burst as automation; losing the logged-in session costs far more than the extra
 * applications are worth, because everything else in JobFinder depends on it.
 */
export async function autoApplyRun(profile, { armed = false, limit = 10 } = {}) {
  const pid = profile.id;
  const jobs = await eligibleJobs(pid, limit);
  const summary = { armed, considered: jobs.length, applied: 0, dryRun: 0, needsInput: 0, skipped: 0, errors: 0, parked: [], results: [] };

  if (!jobs.length) {
    lwarn(pid, '  Nothing eligible — scan first, or every candidate has already been applied to.');
    return summary;
  }

  const ctx = await getContext(pid, 'autoapply', { headless: true, stealth: true, offscreen: true });

  for (const job of jobs) {
    linfo(pid, `  ▸ ${job.title || job.id} @ ${job.company || job.connector}`);
    const r = await autoApplyJob(ctx, profile, job, { armed });

    for (const q of r.missing || []) {
      const p = await parkQuestion(pid, { ...q, jobId: job.id });
      if (p.parked) summary.parked.push(q.label);
    }

    await run(
      'UPDATE jobs SET auto_apply_state = ?, auto_apply_note = ?, auto_applied_at = ? WHERE id = ?',
      [r.state, r.note || '', r.state === 'applied' ? Date.now() : null, job.id]
    );
    if (r.state === 'applied') {
      await run("UPDATE jobs SET status = 'applied', status_changed_at = ? WHERE id = ?", [Date.now(), job.id]);
      summary.applied++;
      lok(pid, `    ✅ ${r.note}`);
    } else if (r.state === 'dry_run') {
      summary.dryRun++;
      lok(pid, `    🧪 ${r.note}`);
    } else if (r.state === 'needs_input' || r.state === 'applied_incomplete') {
      summary.needsInput++;
      lwarn(pid, `    ⏸ ${r.note}`);
    } else if (r.state === 'error') {
      summary.errors++;
      lerr(pid, `    ✗ ${r.note}`);
    } else {
      summary.skipped++;
      linfo(pid, `    – ${r.note}`);
    }
    summary.results.push({ job_id: job.id, title: job.title, company: job.company, connector: job.connector, ...r });

    // Human pacing between applications. A dry run is not applying to anything, so it
    // does not need to look like a person, and waiting 30s x 10 for nothing is silly.
    if (armed) await new Promise((res) => setTimeout(res, 12000 + Math.random() * 18000));
  }

  if (summary.parked.length) {
    lwarn(pid, `  ❓ ${summary.parked.length} question(s) need your answer before those jobs can go out.`);
  }
  return summary;
}
