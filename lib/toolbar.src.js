// The in-page toolbar. Served by /api/toolbar with __JOBFINDER_TOKEN__ and
// __JOBFINDER_ORIGIN__ substituted, and eval'd by the bookmarklet.
//
// Kept as a plain .js file rather than a template literal in a route: the observer
// script taught us that backticks and backslashes inside a JS template silently
// mangle regexes and strings. A real file has no escaping layer at all.
//
// WHY A BOOKMARKLET AND NOT AN EXTENSION
// An MV3 extension would inject itself on every page automatically, which is nicer.
// It cannot be used here: Chrome removed --load-extension, and on this machine's
// Chrome 151 the extension refuses to load in headless AND headful, with or without
// the old --disable-features=DisableLoadExtensionCommandLineSwitch escape hatch.
// Verified before switching approach.
//
// WHAT THIS DOES NOT DO
// It never attaches automation. Pressing a button makes one request to your local
// JobFinder, which attaches transiently server-side and detaches — the same thing the
// dashboard buttons do. While you sit on a human-verification step, nothing is
// connected to this window.

(function () {
  var TOKEN = '__JOBFINDER_TOKEN__';
  var API = '__JOBFINDER_ORIGIN__';

  if (window.__jobfinderToolbarLoaded) {
    if (window.__jobfinderToolbarShow) window.__jobfinderToolbarShow();
    return;
  }
  window.__jobfinderToolbarLoaded = true;

  // ── IFRAMES ────────────────────────────────────────────────────────────────
  // Real application forms are almost always inside an iframe (Greenhouse, Workday,
  // Naukri's apply widget) — which is why autofill already walks page.frames().
  //
  // A keydown goes to the window of the frame that has focus. So while you are typing
  // in the form, keystrokes land in the IFRAME's window, and a listener registered only
  // on the top document never sees them. That is why the hotkeys appeared dead: the
  // toolbar was loaded, just not where your cursor was.
  //
  // Fix: every frame listens; only the top frame draws UI. A sub-frame relays the
  // request upward, stamped with the token so a random script on the page cannot
  // fake it.
  var isTop;
  try { isTop = window === window.top; } catch (e) { isTop = false; }

  function hotkeys(handler) {
    // Match on e.code (physical key), NOT e.key. With Alt held, macOS rewrites e.key
    // to the alternate character — Alt+Shift+S is "Í", never "S" — so an e.key check
    // silently never fires. e.code stays "KeyS" on any layout.
    window.addEventListener('keydown', function (e) {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
      var map = { KeyF: 'llm-fallback', KeyL: 'llm-force', KeyS: 'learn', KeyH: 'hide' };
      var action = map[e.code];
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      handler(action);
    }, true);
  }

  if (!isTop) {
    // Sub-frame: listen and relay. No UI here.
    hotkeys(function (action) {
      try {
        window.top.postMessage({ __jobfinder: 'run', action: action, token: TOKEN }, '*');
      } catch (e) { /* top is gone */ }
    });
    return;
  }

  var host = document.createElement('div');
  // BOTTOM-LEFT, and click-through.
  //
  // This sat bottom-right with the panel auto-opening on every page load — a 279x199
  // block sitting exactly where application forms put Next / Continue / Submit.
  // document.elementFromPoint at the bottom-right corner returned the toolbar, not the
  // button, so clicking "next" did nothing and the following page never opened.
  //
  // pointer-events:none on the host means the widget's empty area never swallows a
  // click; only the pill and the open panel take input (re-enabled below).
  host.style.cssText =
    'all:initial;position:fixed;z-index:2147483647;left:18px;bottom:18px;pointer-events:none;';
  var root = host.attachShadow({ mode: 'closed' });

  var style = document.createElement('style');
  style.textContent = [
    ':host,*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    '.wrap{display:flex;flex-direction:column;align-items:flex-start;gap:8px;pointer-events:none}',
    '.pill,.panel{pointer-events:auto}',
    '.pill{cursor:pointer;user-select:none;border-radius:999px;padding:9px 14px;background:#161b22;color:#c9d1d9;',
    'border:1px solid #30363d;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.35);display:flex;align-items:center;gap:7px}',
    '.pill:hover{border-color:#58a6ff}',
    '.panel{display:none;flex-direction:column;gap:6px;padding:11px;background:#0d1117;border:1px solid #30363d;',
    'border-radius:11px;min-width:250px;box-shadow:0 10px 32px rgba(0,0,0,.5)}',
    '.panel.open{display:flex}',
    '.row{display:flex;gap:6px}',
    'button{flex:1;cursor:pointer;border-radius:7px;padding:8px 10px;font-size:12.5px;background:#21262d;',
    'color:#c9d1d9;border:1px solid #30363d;font-weight:600}',
    'button:disabled{opacity:.5;cursor:default}',
    '.fill{background:#1f6feb22;border-color:#1f6feb;color:#58a6ff}',
    '.llm{background:#8b5cf622;border-color:#8b5cf6;color:#a78bfa}',
    '.learn{background:#23863622;border-color:#238636;color:#3fb950}',
    '.status{font-size:11.5px;color:#8b949e;line-height:1.45;max-width:250px;word-break:break-word}',
    '.status.err{color:#f85149}.status.ok{color:#3fb950}',
    '.keys{font-size:10.5px;color:#6e7681;border-top:1px solid #21262d;padding-top:6px}',
    'kbd{background:#21262d;border:1px solid #30363d;border-radius:4px;padding:0 4px;font-size:10px}',
  ].join('');
  root.appendChild(style);

  var busy = false;
  var statusEl = document.createElement('div');
  statusEl.className = 'status';
  statusEl.textContent = 'Fills from your answer bank, then the LLM.';

  var panel = document.createElement('div');
  panel.className = 'panel';

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function run(mode) {
    if (busy) return;
    panel.classList.add('open');
    busy = true;
    Array.prototype.forEach.call(root.querySelectorAll('button'), function (b) { b.disabled = true; });
    setStatus(mode === 'learn' ? 'Reading this page…' : 'Working — attaching just for this step…');

    fetch(API + '/api/quickfill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: location.href, mode: mode, token: TOKEN }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) setStatus((j && (j.error || j.reason)) || 'Something went wrong.', 'err');
        else setStatus(j.message || 'Done.', 'ok');
      })
      .catch(function () {
        setStatus('Can’t reach JobFinder — is it running on ' + API.replace(/^https?:\/\//, '') + '?', 'err');
      })
      .then(function () {
        busy = false;
        Array.prototype.forEach.call(root.querySelectorAll('button'), function (b) { b.disabled = false; });
      });
  }

  function btn(label, cls, mode) {
    var b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', function () { run(mode); });
    return b;
  }

  var row1 = document.createElement('div');
  row1.className = 'row';
  row1.appendChild(btn('Autofill', 'fill', 'llm-fallback'));
  row1.appendChild(btn('LLM Fill', 'llm', 'llm-force'));

  var row2 = document.createElement('div');
  row2.className = 'row';
  row2.appendChild(btn('📚 Learn this page', 'learn', 'learn'));

  var keys = document.createElement('div');
  keys.className = 'keys';
  keys.innerHTML =
    '<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> fill · <kbd>L</kbd> LLM · <kbd>S</kbd> learn · <kbd>H</kbd> hide';

  panel.appendChild(row1);
  panel.appendChild(row2);
  panel.appendChild(statusEl);
  panel.appendChild(keys);

  var pill = document.createElement('div');
  pill.className = 'pill';
  pill.innerHTML = '<span>🎯</span><span>JobFinder</span>';
  // Drag by the pill, so it can always be moved off whatever it happens to cover.
  var drag = null;
  pill.addEventListener('mousedown', function (e) {
    drag = { x: e.clientX, y: e.clientY, moved: false };
    e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    host.style.left = Math.max(0, e.clientX - 40) + 'px';
    host.style.top = Math.max(0, e.clientY - 16) + 'px';
    host.style.bottom = 'auto';
    host.style.right = 'auto';
  });
  window.addEventListener('mouseup', function () {
    if (drag && !drag.moved) panel.classList.toggle('open');   // a plain click still toggles
    drag = null;
  });

  var wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.appendChild(panel);
  wrap.appendChild(pill);
  root.appendChild(wrap);

  // Mount only once the document exists. Chrome runs this at document-start (that is
  // what makes it survive navigation), and at that point the page is still empty — a
  // node appended to documentElement then gets thrown away when the parser builds the
  // real tree. Symptom: the script reports itself as loaded but no widget is visible.
  function mount() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  function dispatch(action) {
    if (action === 'hide') {
      host.style.display = host.style.display === 'none' ? '' : 'none';
      return;
    }
    run(action);
  }

  // Alt+Shift avoids Chrome's own bindings (Ctrl+Shift+A is tab search) and password
  // managers (Ctrl+Shift+L), and won't fire while you type normally.
  hotkeys(dispatch);

  // Relayed from a focused iframe. The token check stops a page script from driving
  // the toolbar by posting the same message.
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__jobfinder !== 'run' || d.token !== TOKEN) return;
    dispatch(d.action);
  });

  window.__jobfinderToolbarShow = function () {
    host.style.display = '';
    panel.classList.add('open');
  };

  // Peek ONCE per tab so you know it armed, then stay collapsed. Re-opening on every
  // page of a multi-step form is what turned a small pill into a large click blocker.
  try {
    if (!sessionStorage.getItem('__jobfinder_peeked')) {
      sessionStorage.setItem('__jobfinder_peeked', '1');
      panel.classList.add('open');
      setTimeout(function () { panel.classList.remove('open'); }, 2200);
    }
  } catch (e) { /* storage blocked — just stay collapsed */ }
})();
