// Injected as an init script into every page Playwright opens.
// Listens to form input/change events, computes a stable field_key (label-derived),
// and reports {label, value, type, url} back to Node via the exposed binding.

export const OBSERVER_SCRIPT = `(() => {
  if (window.__jobfinderInstalled) return;
  window.__jobfinderInstalled = true;

  const SENSITIVE = /pass(word)?|cvv|card|ssn|secret|otp|verif/i;
  const seen = new Map(); // key -> last value (debounce)

  // ── Fields we must never fill AND never learn from ────────────────────────
  // Honeypots are invisible inputs that only a bot would complete; filling one is
  // an instant bot verdict. CAPTCHAs are unanswerable and poison the bank.
  // Search/filter boxes belong to the job board, not the application.
  var TRAP_RE = /honeypot|hp[_-]?field|robots?\\s*only|do\\s*not\\s*(enter|fill)|leave\\s*(this\\s*)?blank|if\\s*you.?re\\s*human/i;
  var CAPTCHA_RE = /captcha|image\\s*text|security\\s*code|verification\\s*code|type\\s*the\\s*(characters|text|word)/i;
  var SEARCH_RE = /^(search|query|keyword|filter|find)\\b|^enter\\s*(keyword|location)|search\\s*by|designation\\s*(or\\s*)?companies/i;
  // Opaque machine-generated identifiers — a form's internal row IDs, not questions.
  // e.g. "rec form 58158000000003151", "58158000000209084 2"
  var OPAQUE_RE = /^rec[\\s_-]?form|^[\\d\\s._-]+$|\\d{8,}/;

  // A honeypot is defined by being invisible, so measure rather than guess.
  function isHiddenTrap(el) {
    try {
      if (el.type === 'hidden') return true;
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return true;
      if (r.left < -500 || r.top < -500) return true;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return true;
      if (el.getAttribute('aria-hidden') === 'true') return true;
      if (el.tabIndex < 0 && !el.id) return true;
      if (el.offsetParent === null && cs.position !== 'fixed') return true;
    } catch (e) {}
    return false;
  }

  // Should this field participate at all — in filling or in learning?
  function isUsable(el, label) {
    var hay = (label || '') + ' ' + (el.name || '') + ' ' + (el.id || '') + ' ' + (el.className || '');
    if (TRAP_RE.test(hay)) return false;
    if (CAPTCHA_RE.test(hay)) return false;
    if (SEARCH_RE.test(label || '') || SEARCH_RE.test(el.name || '')) return false;
    if (el.getAttribute && el.getAttribute('role') === 'search') return false;
    if (el.closest && el.closest('[role=search], form[role=search], .search-bar, #search')) return false;
    if (isHiddenTrap(el)) return false;
    return true;
  }

  // Does this value make sense for this field? Catches the "linkedin profile =
  // Kolkata" class of corruption at the point of entry.
  function plausible(type, label, value) {
    var v = String(value).trim();
    if (!v) return false;
    var lbl = (label || '').toLowerCase();
    if (type === 'email' || /e-?mail/.test(lbl)) return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v);
    if (type === 'url' || /linkedin|github|portfolio|website|profile\\s*link/.test(lbl)) {
      return /(https?:\\/\\/|www\\.|\\.[a-z]{2,}\\/)/i.test(v);
    }
    if (type === 'tel' || /phone|mobile/.test(lbl)) return (v.replace(/\\D/g, '').length >= 7);
    if (/^(zip|postal)/.test(lbl) || /zip|postcode/.test(lbl)) return /\\d/.test(v);
    if (/(salary|ctc|compensation|notice period|years? of experience|age)/.test(lbl)) return /\\d/.test(v);
    // A one-word answer to an essay question is almost always a misfire.
    if (lbl.length > 60 && v.split(/\\s+/).length < 3) return false;
    if (/(cover letter|describe|explain|tell us|write about|why do you|how do you|in max)/.test(lbl)
        && v.split(/\\s+/).length < 8) return false;
    return true;
  }

  // Collapse the many ways a site can ask for the same fact into one key, so the
  // bank holds one authoritative answer instead of six drifting copies.
  var CANON = [
    [/^(first|given)\\s*name/, 'first name'],
    [/^(last|family|sur)\\s*name/, 'last name'],
    [/(full|candidate|your)\\s*name$|^name$/, 'full name'],
    [/linkedin/, 'linkedin url'],
    [/(github|portfolio|personal\\s*website|work\\s*link)/, 'portfolio url'],
    [/e-?mail/, 'email'],
    [/(phone|mobile)\\s*(number|no)?$|^phone/, 'phone'],
    [/notice\\s*period/, 'notice period'],
    [/(current|present)\\s*(annual\\s*)?(ctc|salary|compensation)/, 'current ctc'],
    [/expected\\s*(annual\\s*)?(ctc|salary|compensation)/, 'expected ctc'],
    [/(total\\s*)?years?\\s*of\\s*experience|^experience\\s*\\(?years/, 'years of experience'],
    [/current\\s*(company|employer)/, 'current company'],
    [/current\\s*(designation|title|role|job\\s*title)/, 'current designation'],
    [/(current\\s*)?(city|location)$|^city/, 'city'],
    [/(zip|postal)\\s*code/, 'zip code'],
    [/^country/, 'country'],
    [/nationality|citizenship/, 'nationality'],
  ];
  function canonical(key, type) {
    for (var i = 0; i < CANON.length; i++) {
      if (CANON[i][0].test(key)) return CANON[i][1];
    }
    if (type === 'email') return 'email';
    if (type === 'tel') return 'phone';
    return key;
  }

  // Sites label the same control twice — a visible <label> plus an aria-label, or a
  // wrapper whose innerText contains both — and the two get concatenated into
  // "Total years of experience Total years of experi". That string becomes the
  // answer-bank key, so the same question asked elsewhere never matches it, and the
  // question you are shown reads like a stutter. Collapse a doubled label back to one,
  // including when the second copy was cut short by a length cap.
  function collapseRepeat(s) {
    var w = String(s || '').trim().split(/\\s+/);
    if (w.length < 4) return String(s || '').trim();
    // Scan from the LONGEST possible first copy downwards, not from the midpoint: when
    // the second copy is truncated the split sits past halfway, which a midpoint-down
    // loop never reaches.
    for (var k = w.length - 2; k >= 2; k--) {
      var head = w.slice(0, k).join(' ');
      var tailWords = w.slice(k);
      if (tailWords.length < 2) continue;      // one repeated word is a coincidence
      var tail = tailWords.join(' ');
      if (head.length >= tail.length && head.toLowerCase().indexOf(tail.toLowerCase()) === 0) return head;
    }
    return w.join(' ');
  }

  function labelFor(el) {
    return collapseRepeat(labelForRaw(el));
  }

  function labelForRaw(el) {
    if (!el) return '';
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    const lblId = el.getAttribute('aria-labelledby');
    if (lblId) {
      const l = document.getElementById(lblId);
      if (l) return l.innerText.trim();
    }
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) return l.innerText.trim();
    }
    let p = el.parentElement;
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
      if (p.tagName === 'LABEL') return p.innerText.replace(el.value || '', '').trim();
      const lbl = p.querySelector('label, .label, [class*=label]');
      if (lbl && lbl !== el) {
        const t = lbl.innerText.trim();
        if (t && t.length < 200) return t;
      }
    }
    return el.placeholder || el.name || '';
  }

  function fieldKey(label, name, type) {
    const raw = (label || name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\\s+/g, ' ').trim();
    if (!raw) return (name || type || 'unknown');
    return canonical(raw.slice(0, 120), type);
  }

  // ── The feedback loop, and why this exists ────────────────────────────────
  // setNativeValue dispatches 'input' and 'change' so the host page's framework
  // notices the write. The observer listens to those same events — so every value
  // autofill guessed was immediately recorded as though you had typed it. A weak
  // semantic guess ("certifications" → "Kolkata") became an EXACT-match answer,
  // which the next run filled with total confidence, never reaching the vector
  // stage at all. That is how one wrong guess turned into twelve bad rows.
  //
  // So: tag anything we wrote ourselves, and refuse to learn from it. Only a human
  // keystroke creates knowledge. If you later edit the field, the value no longer
  // matches the tag and it is learned normally — your correction is what we want.
  function markMachineWritten(el, value) {
    try { el.__jfMachine = String(value); } catch (e) {}
  }
  function isMachineWritten(el, value) {
    try { return el.__jfMachine != null && el.__jfMachine === String(value); } catch (e) { return false; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // OFFLINE BUFFER
  //
  // window.__jobfinderObserve is an exposeBinding — it only exists while Playwright
  // is attached. Under lazy-attach that is a ~2 second window during Autofill, so
  // everything typed AFTERWARDS (the corrections, the fields the LLM left blank,
  // the answers written just before hitting Submit) reached nothing and was lost.
  //
  // This script is ordinary page JavaScript though: it keeps running with zero
  // automation attached. It just needs somewhere to put what it sees. So every
  // observation is also written to localStorage, and the next attach drains it.
  // Nothing here weakens the detached-for-verification property — no CDP client,
  // no network, purely a same-origin key/value write.
  // ══════════════════════════════════════════════════════════════════════════
  var BUFFER_KEY = '__jobfinder_buffer_v1';
  var BUFFER_MAX = 200;
  var JF_ATTR = 'data-jf-target';
  var jfSeq = 0;

  function bufferPush(entry) {
    try {
      var raw = window.localStorage.getItem(BUFFER_KEY);
      var list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) list = [];
      // Last write per field_key wins — corrections should overwrite, not stack up.
      list = list.filter(function (e) { return e && e.field_key !== entry.field_key; });
      list.push(entry);
      if (list.length > BUFFER_MAX) list = list.slice(list.length - BUFFER_MAX);
      window.localStorage.setItem(BUFFER_KEY, JSON.stringify(list));
    } catch (e) { /* private mode / quota / storage disabled — non-fatal */ }
  }

  // Called by the Node side on attach: hand over everything buffered and clear.
  window.__jobfinderDrainBuffer = function () {
    try {
      var raw = window.localStorage.getItem(BUFFER_KEY);
      window.localStorage.removeItem(BUFFER_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  };

  // Snapshot every currently-filled field, regardless of whether we saw it typed.
  // Catches browser-autofilled values and anything entered before this script loaded.
  window.__jobfinderSnapshotFilled = function () {
    var out = [];
    try {
      var els = document.querySelectorAll('input, textarea, select');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var tag = el.tagName.toLowerCase();
        var type = (el.type || tag).toLowerCase();
        if (['password', 'hidden', 'submit', 'button', 'file', 'checkbox', 'radio'].indexOf(type) !== -1) continue;
        var value = (el.value || '').trim();
        if (!value || value.length > 5000) continue;
        var label = labelFor(el);
        if (!label) continue;
        if (SENSITIVE.test(label) || SENSITIVE.test(el.name || '')) continue;
        if (!isUsable(el, label)) continue;
        if (isMachineWritten(el, value)) continue;
        var skey = fieldKey(label, el.name, type);
        if (OPAQUE_RE.test(skey)) continue;
        if (!plausible(type, label, value)) continue;
        out.push({
          field_key: skey,
          label: label.slice(0, 200),
          value: value.slice(0, 5000),
          type: type,
          url: location.href,
        });
      }
    } catch (e) {}
    return out;
  };

  function report(el) {
    try {
      if (!el || !el.tagName) return;
      const tag = el.tagName.toLowerCase();
      if (!['input', 'textarea', 'select'].includes(tag)) return;
      const type = (el.type || tag).toLowerCase();
      if (['password', 'hidden', 'submit', 'button', 'file', 'checkbox', 'radio'].includes(type)) return;
      const value = (el.value || '').trim();
      if (!value || value.length > 5000) return;
      const label = labelFor(el);
      if (SENSITIVE.test(label) || SENSITIVE.test(el.name || '')) return;
      if (!isUsable(el, label)) return;               // honeypot / captcha / search box
      if (isMachineWritten(el, value)) return;        // our own guess — not knowledge
      const key = fieldKey(label, el.name, type);
      if (OPAQUE_RE.test(key)) return;                // internal form IDs, not questions
      if (!plausible(type, label, value)) return;     // "linkedin profile = Kolkata"
      if (seen.get(key) === value) return;
      seen.set(key, value);
      const entry = {
        field_key: key,
        label: label.slice(0, 200),
        value: value.slice(0, 5000),
        type,
        url: location.href,
      };
      // Live binding when attached, buffer always. The buffer is what makes this
      // work during the (usual) case where nothing is attached.
      window.__jobfinderObserve && window.__jobfinderObserve(entry);
      bufferPush(entry);
    } catch {}
  }

  let timer = null;
  function debounced(el) {
    clearTimeout(timer);
    timer = setTimeout(() => report(el), 600);
  }

  document.addEventListener('input', (e) => debounced(e.target), true);
  document.addEventListener('change', (e) => report(e.target), true);
  document.addEventListener('blur', (e) => report(e.target), true);

  // Submitting is the single most valuable moment to capture: the form is at its
  // most complete, and the page is about to navigate away and take everything with
  // it. Snapshot synchronously so the write lands before unload.
  function captureAll() {
    try {
      var all = window.__jobfinderSnapshotFilled();
      for (var i = 0; i < all.length; i++) bufferPush(all[i]);
    } catch (e) {}
  }
  document.addEventListener('submit', captureAll, true);
  window.addEventListener('beforeunload', captureAll);
  window.addEventListener('pagehide', captureAll);
  // Clicking a submit-ish control often posts via JS without firing a submit event.
  document.addEventListener('click', function (e) {
    try {
      var t = e.target;
      if (!t || !t.closest) return;
      var btn = t.closest('button, input[type=submit], [role=button]');
      if (!btn) return;
      var txt = ((btn.innerText || btn.value || '') + ' ' + (btn.getAttribute('aria-label') || '')).toLowerCase();
      if (/submit|apply|send|continue|next|finish|save/.test(txt)) captureAll();
    } catch (err) {}
  }, true);

  // Expose autofill. Returns:
  //   filled: number of fields populated via exact field_key match against the answers map.
  //   unfilledTargets: every other visible, eligible field with a usable label.
  //     The Node-side autofill engine then attempts semantic retrieval and (if the
  //     field is long-form) LLM drafting for each one.
  window.__jobfinderFill = function(answers, opts = {}) {
    const unfilledTargets = [];
    // Clear tokens from any previous run so stale ones can never be resolved.
    try {
      var old = document.querySelectorAll('[' + JF_ATTR + ']');
      for (var oi = 0; oi < old.length; oi++) old[oi].removeAttribute(JF_ATTR);
    } catch (e) {}
    // Fields the user has ALREADY filled in (manually or by the page's own logic).
    // We return these to the Node side so they get saved to the answer bank — that
    // way the system learns from what you typed BEFORE clicking Autofill, even in
    // lazy-attach mode where the live observer binding wasn't active when you typed.
    const prefilled = [];
    // opts.root scopes the scan to one container. Auto-apply needs this: LinkedIn's
    // apply dialog sits in a page that ALSO contains the global search box, a language
    // <select> in the footer, and an invisible reCAPTCHA textarea. Scanning the whole
    // document there means typing your notice period into LinkedIn's search bar.
    var scanRoot = document;
    if (opts.root) {
      try { scanRoot = document.querySelector(opts.root) || document; } catch (e) {}
    }
    const fields = scanRoot.querySelectorAll('input, textarea, select');
    let filled = 0;
    for (const el of fields) {
      const tag = el.tagName.toLowerCase();
      const type = (el.type || tag).toLowerCase();
      if (['password', 'hidden', 'submit', 'button', 'file', 'checkbox', 'radio'].includes(type)) continue;
      // Only consider visible fields
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (el.disabled || el.readOnly) continue;

      const label = labelFor(el);
      if (!label) continue; // can't reason about it
      // Never fill a honeypot, a CAPTCHA, or the site's own search box. Completing a
      // honeypot is a self-inflicted bot verdict — it is the one field on the page a
      // real person provably cannot see.
      if (!isUsable(el, label)) continue;
      const key = fieldKey(label, el.name, type);
      if (OPAQUE_RE.test(key)) continue;

      // If the field is already filled, harvest its value for the answer bank,
      // then skip (unless overwrite is true, in which case continue to fill logic).
      let existing = (el.value || '').trim();

      // A dropdown sitting on "Select an option" is EMPTY, whatever .value says.
      // LinkedIn gives that placeholder a real option value (a URN), so it read as
      // already-answered: the field was never offered for filling, never set, and the
      // form then refused to advance with no visible reason. Judge a select by the
      // text of its selected option, which is what a person sees.
      if (tag === 'select') {
        var selOpt = el.options[el.selectedIndex];
        var selText = selOpt ? (selOpt.text || '').trim() : '';
        if (!selText || /^(select|please select|please choose|choose)\\b/i.test(selText) || /^-+/.test(selText)) {
          existing = '';
        }
      }
      if (existing && !opts.overwrite) {
        if (existing.length <= 5000 && !SENSITIVE.test(label) && !SENSITIVE.test(el.name || '')
            && !isMachineWritten(el, existing) && plausible(type, label, existing)) {
          prefilled.push({ field_key: key, label: label.slice(0, 200), value: existing, type });
        }
        continue;
      }

      // Step 1: exact field_key hit → fill directly without involving the LLM.
      const val = answers[key];
      if (val != null) {
        setNativeValue(el, val);
        filled++;
        continue;
      }

      // Step 2: queue for Node-side semantic retrieval + possible LLM draft.
      // isLong = textarea OR an input that allows a lot of text (writeup-style).
      const maxLen = el.maxLength;
      const isLong = tag === 'textarea' || (maxLen === -1 && tag === 'input' && type === 'text') || maxLen > 300;
      // Address the element by a unique token stamped onto it now, not by a CSS
      // path recomputed later. Paths built from tag/class/nth-of-type shift when a
      // framework re-renders the form between the scan and the write — and a shifted
      // path silently resolves to the WRONG field. A token moves with the element.
      var token = 'jf' + (++jfSeq);
      try { el.setAttribute(JF_ATTR, token); } catch (e) {}
      // Auto-apply needs two things ordinary autofill never did.
      //
      // required: a form you cannot complete is the whole reason auto-apply stops and
      // asks you. Sites express it three ways and use all of them, so check all three:
      // the attribute, the ARIA flag, and the asterisk that is often the ONLY marker
      // on a custom widget with no real <input> semantics.
      var required = false;
      try {
        required = !!(el.required || el.getAttribute('aria-required') === 'true');
        if (!required) {
          var host = el.closest('div,fieldset,li') || el.parentElement;
          var htext = host ? (host.innerText || '') : '';
          // Match a standalone marker, not a stray asterisk inside prose.
          required = /\\*\\s*$|\\*\\s|\\bRequired\\b/.test(htext.slice(0, 200));
        }
      } catch (e) {}

      // options: a dropdown answer has to BE one of the choices. Sending "5 years" to
      // a select whose options are "0-2","3-5","6+" silently sets nothing, and the
      // form then fails validation with no clue why.
      var options = null;
      try {
        if (tag === 'select') {
          options = [];
          for (var oi2 = 0; oi2 < el.options.length; oi2++) {
            var ot = (el.options[oi2].text || '').trim();
            // "Select an option" is the prompt, not a choice. Offering it back as a
            // possible answer produces a form that stays invalid while looking filled.
            if (!ot || /^(select|please select|choose|-+\\s*select|\\.\\.\\.)$/i.test(ot)
                || /^(select|please choose|please select)\\b/i.test(ot)) continue;
            options.push(ot.slice(0, 80));
          }
          options = options.slice(0, 60);
        }
      } catch (e) {}

      unfilledTargets.push({
        key, label,
        selector: '[' + JF_ATTR + '="' + token + '"]',
        fallbackSelector: cssPath(el),
        type,
        isLong,
        required: required,
        options: options,
        url: location.href,
      });
    }
    return { filled, unfilledTargets, prefilled, llmTargets: unfilledTargets /* compat */ };
  };

  function setNativeValue(el, value) {
    // A <select> needs its own prototype — calling the HTMLInputElement value setter
    // on one throws "illegal invocation", which the old catch swallowed, so dropdowns
    // silently never filled.
    if (el.tagName === 'SELECT') {
      var want = String(value).trim().toLowerCase();
      for (var i = 0; i < el.options.length; i++) {
        var o = el.options[i];
        if (o.value.trim().toLowerCase() === want || o.text.trim().toLowerCase() === want) {
          el.selectedIndex = i;
          markMachineWritten(el, el.value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
      return; // no matching option — leave it alone rather than forcing a bad value
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    markMachineWritten(el, el.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function cssPath(el) {
    if (!el) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 6) {
      let s = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        s += '.' + el.className.trim().split(/\\s+/).slice(0, 2).map((c) => CSS.escape(c)).join('.');
      }
      const sib = el.parentNode ? Array.from(el.parentNode.children).filter((c) => c.tagName === el.tagName) : [];
      if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(el) + 1) + ')';
      parts.unshift(s);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  // Write a value into a field that was identified during an earlier scan.
  //
  // CRITICAL: there can be MINUTES between the scan and this call — the LLM pass
  // drafts up to 12 fields two at a time, and each draft is a full local generation.
  // You keep typing during that wait. So a field that was empty when we scanned is
  // very often filled by the time the draft comes back, and blindly writing here
  // destroys what you just typed.
  //
  // Everything below re-validates against the CURRENT state of the page rather than
  // trusting the snapshot. Refusing to write is always the safe outcome: a blank
  // field costs you a moment, an overwritten one costs you the answer.
  window.__jobfinderSetByPath = function(path, value, opts) {
    opts = opts || {};
    try {
      const el = document.querySelector(path);
      if (!el) return { ok: false, reason: 'gone' };
      if (el.disabled || el.readOnly) return { ok: false, reason: 'locked' };

      // You are typing in this field right now. Never write over an active cursor.
      if (document.activeElement === el) return { ok: false, reason: 'focused' };

      const current = (el.value || '').trim();
      if (current && !opts.overwrite) {
        // Idempotent re-run: the value is already what we wanted. Not a conflict.
        if (current === String(value).trim()) return { ok: true, reason: 'already' };
        return { ok: false, reason: 'occupied', current: current.slice(0, 80) };
      }

      setNativeValue(el, value);
      return { ok: true, reason: 'filled' };
    } catch (e) { return { ok: false, reason: 'error' }; }
  };
})();`;
