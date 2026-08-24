// Per-profile per-connector Playwright persistent contexts.
// Cookies/login state live under ./data/sessions/<profileId>/<connector>
//
// Anti-bot strategy:
//   1. Prefer a real Chrome/Brave/Chromium installation launched via CDP
//      (avoids Playwright's bundled Chromium which is trivially fingerprinted).
//   2. Inject stealth init-scripts that patch navigator.webdriver, plugins,
//      permissions, and window.chrome so the page can't distinguish us from
//      a regular user session.
//   3. Fall back to Playwright's launchPersistentContext if no real browser is
//      found, but still apply the same stealth patches.

import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { OBSERVER_SCRIPT } from './observer.js';
import { recordAnswer } from './answerBank.js';

// Silence the noisy `[rebrowser-patches][frames._context] cannot get world` errors
// that fire when rebrowser's instrumentation runs against tabs that are already
// closing (e.g. Chrome's startup about:blank, or a scrape page we just closed).
// They have no functional impact — the patch just couldn't decorate a dead session.
//
// These are logged as `console.error('[rebrowser-patches]…', errorObject)`, so the
// telltale text lives in the FIRST arg (the prefix) while the "session closed"
// detail is in the second. We therefore suppress on the `[rebrowser-patches]`
// prefix alone — every line with that tag is internal patch noise, never actionable.
const _origConsoleError = console.error;
console.error = (...args) => {
  if (args.some((a) => String(a?.message || a || '').includes('[rebrowser-patches]'))) return;
  _origConsoleError.apply(console, args);
};
process.on('unhandledRejection', (reason) => {
  const msg = String(reason?.message || reason || '');
  if (/Page\.createIsolatedWorld|session closed|Target closed/i.test(msg) || msg.includes('rebrowser')) return;
  _origConsoleError('[unhandledRejection]', reason);
});

// ── Browser detection ───────────────────────────────────────────────────────

const CANDIDATE_BROWSERS = [
  { name: 'Google Chrome',             path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  { name: 'Google Chrome for Testing', path: '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' },
  { name: 'Brave Browser',             path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
  { name: 'Microsoft Edge',            path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
  { name: 'Arc',                       path: '/Applications/Arc.app/Contents/MacOS/Arc' },
  { name: 'Chromium',                  path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
];

function detectBrowser() {
  for (const b of CANDIDATE_BROWSERS) {
    if (fs.existsSync(b.path)) return b;
  }
  return null;
}

const _detected = detectBrowser();
// Print the detection result once at module load, so the launcher Terminal makes the
// situation obvious instead of silently falling through to bundled Chromium.
console.log(_detected
  ? `[browser] ✅ Real browser detected: ${_detected.name} (${_detected.path})`
  : `[browser] ⚠️  No real browser detected. Will use bundled Chromium fallback. Checked:\n  ${CANDIDATE_BROWSERS.map((b) => b.path).join('\n  ')}`);

/** Reports which real browser (if any) was detected on this machine. */
export const BROWSER_INFO = Object.freeze({
  detected: !!_detected,
  name: _detected?.name ?? null,
  path: _detected?.path ?? null,
});

// ── Stealth init-script (injected into every new context) ───────────────────

// NOTE: this whole script lives inside a JS template literal, so it must contain NO
// backticks and no ${...} sequences. Use string concatenation instead.
const STEALTH_SCRIPT_CHROMIUM = `
(() => {
  if (window.__jfStealthInstalled) return;
  window.__jfStealthInstalled = true;

  // ══════════════════════════════════════════════════════════════════════════
  // 0. NATIVE-CODE MASKING — the single most important anti-detection measure.
  //
  // Every property we patch below replaces a native getter with a JS function.
  // Detectors (Cloudflare, DataDome, PerimeterX, Kasada) read the source of those
  // functions:
  //     Object.getOwnPropertyDescriptor(navigator,'webdriver').get.toString()
  // Real Chrome returns "function get webdriver() { [native code] }".
  // An unmasked patch returns "() => undefined" — an instant, unambiguous bot flag.
  //
  // We install a Proxy over Function.prototype.toString that returns a native-looking
  // string for any function we've registered, and behaves normally for everything
  // else. The proxy registers ITSELF so toString.toString() is also native-looking.
  // ══════════════════════════════════════════════════════════════════════════
  const nativeToString = Function.prototype.toString;
  const fakeSources = new WeakMap();

  function asNative(fn, name) {
    fakeSources.set(fn, 'function ' + (name || fn.name || '') + '() { [native code] }');
    return fn;
  }

  const toStringProxy = new Proxy(nativeToString, {
    apply(target, thisArg, args) {
      if (typeof thisArg === 'function' && fakeSources.has(thisArg)) {
        return fakeSources.get(thisArg);
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  asNative(toStringProxy, 'toString');
  Function.prototype.toString = toStringProxy;

  // Helper: define a property whose getter reports as native code.
  function defineNativeGetter(obj, prop, getterImpl) {
    const g = function () { return getterImpl(); };
    asNative(g, 'get ' + prop);
    Object.defineProperty(obj, prop, { get: g, configurable: true, enumerable: false });
  }

  // Helper: replace a method with one that reports as native code.
  function replaceNativeMethod(obj, prop, impl) {
    asNative(impl, prop);
    Object.defineProperty(obj, prop, { value: impl, configurable: true, writable: true });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. navigator.webdriver.
  //
  // Subtle but important: do NOT delete the property. Real, non-automated Chrome
  // HAS navigator.webdriver and it returns false — so ('webdriver' in navigator)
  // is true. Deleting it makes that check return false, which no real Chrome ever
  // does, i.e. deleting swaps one bot signal for a different bot signal.
  // The accurate spoof is: property present, value false, getter looks native.
  // ══════════════════════════════════════════════════════════════════════════
  defineNativeGetter(Navigator.prototype, 'webdriver', () => false);

  // ══════════════════════════════════════════════════════════════════════════
  // 2. navigator.plugins / mimeTypes.
  //
  // Built ONCE and cached. The previous implementation rebuilt the PluginArray on
  // every access, so navigator.plugins[0] === navigator.plugins[0] evaluated to
  // false — impossible in a real browser and trivially detectable.
  // ══════════════════════════════════════════════════════════════════════════
  const pluginSpec = [
    { name: 'PDF Viewer',           filename: 'internal-pdf-viewer' },
    { name: 'Chrome PDF Viewer',    filename: 'internal-pdf-viewer' },
    { name: 'Chromium PDF Viewer',  filename: 'internal-pdf-viewer' },
    { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer' },
    { name: 'WebKit built-in PDF',  filename: 'internal-pdf-viewer' },
  ];
  const mimeSpec = [
    { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    { type: 'text/pdf',        suffixes: 'pdf', description: 'Portable Document Format' },
  ];

  const mimeObjects = [];
  const pluginObjects = [];

  for (const p of pluginSpec) {
    const plugin = Object.create(Plugin.prototype);
    Object.defineProperties(plugin, {
      name:        { value: p.name,        enumerable: true },
      filename:    { value: p.filename,    enumerable: true },
      description: { value: 'Portable Document Format', enumerable: true },
      length:      { value: mimeSpec.length, enumerable: true },
    });
    pluginObjects.push(plugin);
  }

  for (const m of mimeSpec) {
    const mime = Object.create(MimeType.prototype);
    Object.defineProperties(mime, {
      type:          { value: m.type,        enumerable: true },
      suffixes:      { value: m.suffixes,    enumerable: true },
      description:   { value: m.description, enumerable: true },
      enabledPlugin: { value: pluginObjects[0], enumerable: true },
    });
    mimeObjects.push(mime);
  }
  // Wire mimes onto each plugin (indexed + named access, like real Chrome).
  for (const plugin of pluginObjects) {
    mimeObjects.forEach((m, i) => {
      Object.defineProperty(plugin, i, { value: m, enumerable: true });
      Object.defineProperty(plugin, m.type, { value: m, enumerable: false });
    });
  }

  function buildArray(proto, items, keyProp) {
    const arr = Object.create(proto);
    items.forEach((item, i) => {
      Object.defineProperty(arr, i, { value: item, enumerable: true });
      Object.defineProperty(arr, item[keyProp], { value: item, enumerable: false });
    });
    Object.defineProperty(arr, 'length', { value: items.length, enumerable: false });
    replaceNativeMethod(arr, 'item', function (i) { return items[i] || null; });
    replaceNativeMethod(arr, 'namedItem', function (n) {
      return items.find((x) => x[keyProp] === n) || null;
    });
    Object.defineProperty(arr, Symbol.iterator, {
      value: function () { return items[Symbol.iterator](); },
      enumerable: false,
    });
    return arr;
  }

  // Frozen singletons — identity is stable across accesses, as in real Chrome.
  const pluginArray = buildArray(PluginArray.prototype, pluginObjects, 'name');
  const mimeTypeArray = buildArray(MimeTypeArray.prototype, mimeObjects, 'type');

  defineNativeGetter(Navigator.prototype, 'plugins',   () => pluginArray);
  defineNativeGetter(Navigator.prototype, 'mimeTypes', () => mimeTypeArray);
  defineNativeGetter(Navigator.prototype, 'pdfViewerEnabled', () => true);

  // ══════════════════════════════════════════════════════════════════════════
  // 3. Locale / hardware consistency. Values must agree with the UA and each
  //    other — mismatches (e.g. 0 cores, 'Linux' platform + Mac UA) are flagged.
  // ══════════════════════════════════════════════════════════════════════════
  defineNativeGetter(Navigator.prototype, 'languages', () => Object.freeze(['en-US', 'en']));
  if (!navigator.hardwareConcurrency || navigator.hardwareConcurrency < 2) {
    defineNativeGetter(Navigator.prototype, 'hardwareConcurrency', () => 8);
  }
  if (navigator.deviceMemory === undefined) {
    defineNativeGetter(Navigator.prototype, 'deviceMemory', () => 8);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 4. window.chrome — real Chrome exposes app/csi/loadTimes/runtime. Headless and
  //    naive automation setups are missing most of these.
  // ══════════════════════════════════════════════════════════════════════════
  if (!window.chrome) window.chrome = {};
  const chromeObj = window.chrome;

  if (!chromeObj.app) {
    chromeObj.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    };
    replaceNativeMethod(chromeObj.app, 'getDetails', function () { return null; });
    replaceNativeMethod(chromeObj.app, 'getIsInstalled', function () { return false; });
    replaceNativeMethod(chromeObj.app, 'runningState', function () { return 'cannot_run'; });
  }
  if (!chromeObj.csi) {
    replaceNativeMethod(chromeObj, 'csi', function () {
      const t = window.performance && performance.timing;
      const start = t ? t.navigationStart : Date.now();
      return {
        onloadT: t ? t.domContentLoadedEventEnd : Date.now(),
        startE: start,
        pageT: Date.now() - start,
        tran: 15,
      };
    });
  }
  if (!chromeObj.loadTimes) {
    replaceNativeMethod(chromeObj, 'loadTimes', function () {
      const t = window.performance && performance.timing;
      const start = t ? t.navigationStart / 1000 : Date.now() / 1000;
      return {
        commitLoadTime: start,
        connectionInfo: 'h2',
        finishDocumentLoadTime: start,
        finishLoadTime: start,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: start,
        navigationType: 'Other',
        npnNegotiatedProtocol: 'h2',
        requestTime: start,
        startLoadTime: start,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
      };
    });
  }
  if (!chromeObj.runtime) {
    chromeObj.runtime = {
      OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', UPDATE: 'update' },
      PlatformArch: { ARM: 'arm', ARM64: 'arm64', X86_32: 'x86-32', X86_64: 'x86-64' },
      PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', WIN: 'win' },
    };
    replaceNativeMethod(chromeObj.runtime, 'sendMessage', function () {});
    replaceNativeMethod(chromeObj.runtime, 'connect', function () {
      return {
        onMessage: { addListener: function () {}, removeListener: function () {} },
        postMessage: function () {},
        disconnect: function () {},
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 5. Permissions.query — headless Chrome famously returns 'denied' for
  //    notifications while Notification.permission says 'default'. That
  //    contradiction is a well-known headless tell.
  // ══════════════════════════════════════════════════════════════════════════
  const origQuery = Permissions.prototype.query;
  replaceNativeMethod(Permissions.prototype, 'query', function (params) {
    if (params && params.name === 'notifications') {
      return Promise.resolve({
        state: Notification.permission === 'denied' ? 'denied' : 'prompt',
        onchange: null,
        name: 'notifications',
      });
    }
    return origQuery.call(this, params);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 6. WebGL vendor / renderer. Headless + software-rendered Chrome reports
  //    "Google SwiftShader" / "Mesa OffScreen", both hard bot signals. Report the
  //    values a real Chrome on Apple Silicon returns.
  // ══════════════════════════════════════════════════════════════════════════
  const UNMASKED_VENDOR = 37445;
  const UNMASKED_RENDERER = 37446;
  function patchWebGL(proto) {
    if (!proto || !proto.getParameter) return;
    const orig = proto.getParameter;
    replaceNativeMethod(proto, 'getParameter', function (param) {
      if (param === UNMASKED_VENDOR) return 'Google Inc. (Apple)';
      if (param === UNMASKED_RENDERER) return 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)';
      if (param === 7936)  return 'WebKit';                 // VENDOR
      if (param === 7937)  return 'WebKit WebGL';           // RENDERER
      return orig.call(this, param);
    });
  }
  if (typeof WebGLRenderingContext !== 'undefined')  patchWebGL(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext.prototype);

  // ══════════════════════════════════════════════════════════════════════════
  // 7. iframe.contentWindow.chrome — detectors create a hidden iframe and check
  //    whether the child window inherits a plausible chrome object.
  // ══════════════════════════════════════════════════════════════════════════
  try {
    const origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    if (origContentWindow && origContentWindow.get) {
      const origGet = origContentWindow.get;
      const patchedGet = function () {
        const win = origGet.call(this);
        try { if (win && !win.chrome) win.chrome = chromeObj; } catch (e) {}
        return win;
      };
      asNative(patchedGet, 'get contentWindow');
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        get: patchedGet, configurable: true,
      });
    }
  } catch (e) {}

  // ══════════════════════════════════════════════════════════════════════════
  // 8. Scrub CDP / automation artifacts that leak onto the window object.
  // ══════════════════════════════════════════════════════════════════════════
  const AUTOMATION_KEYS = [
    'cdc_adoQpoasnfa76pfcZLmcfl_Array',
    'cdc_adoQpoasnfa76pfcZLmcfl_Promise',
    'cdc_adoQpoasnfa76pfcZLmcfl_Symbol',
    '__webdriver_evaluate', '__selenium_evaluate', '__webdriver_script_function',
    '__webdriver_script_func', '__webdriver_script_fn', '__fxdriver_evaluate',
    '__driver_unwrapped', '__webdriver_unwrapped', '__driver_evaluate',
    '__selenium_unwrapped', '__fxdriver_unwrapped', '_Selenium_IDE_Recorder',
    '_selenium', 'calledSelenium', '__nightmare', '__phantomas', 'domAutomation',
    'domAutomationController',
  ];
  for (const k of AUTOMATION_KEYS) {
    try { delete window[k]; } catch (e) {}
    try { delete document[k]; } catch (e) {}
  }
})();
`;

const STEALTH_SCRIPT_FIREFOX = `
(() => {
  // Firefox stealth: Just delete navigator.webdriver
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
})();
`;

// ── Internals ───────────────────────────────────────────────────────────────

const live = new Map();           // key -> { context, browser?, childProcess? } (attached scan windows)
const portMap = new Map();        // key -> port (for CDP)
const launching = new Map();      // key -> Promise<context> (in-flight launch de-dup)
// Per-profile Chrome processes for the LAZY-ATTACH model. Chrome runs with the debug
// port open but NO Playwright client connected by default — visually + JS-fingerprint
// indistinguishable from plain Chrome. Autofill attaches transiently via CDP, runs,
// and detaches. Verification submissions then run against a window with no live
// Playwright instrumentation.
const lazy = new Map();           // profileId -> { port, child, userDataDir }
let nextPort = 9222;

// All sites for a profile share ONE user-data-dir → one Chrome window with multiple
// tabs, just like a normal browser. Cookies are domain-scoped so LinkedIn and Reddit
// happily coexist. The per-connector dir layout we used to have is gone — but to
// preserve existing logins we copy the freshest legacy session into the new shared
// dir on first use.
function sessionDir(profileId, _connector) {
  const profileRoot = path.join(process.cwd(), 'data', 'sessions', profileId);
  const sharedDir = path.join(profileRoot, 'main');
  if (fs.existsSync(sharedDir)) return sharedDir;

  fs.mkdirSync(sharedDir, { recursive: true });
  // One-time migration: if there are legacy per-connector sub-dirs, pick the one
  // whose Cookies file is freshest and copy it into the new shared dir so the user
  // doesn't lose the most-recent login.
  try {
    if (fs.existsSync(profileRoot)) {
      const subs = fs.readdirSync(profileRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== 'main')
        .map((d) => {
          const cookiesPath = path.join(profileRoot, d.name, 'Default', 'Cookies');
          let mtime = 0;
          try { mtime = fs.statSync(cookiesPath).mtimeMs; } catch { /* missing */ }
          return { name: d.name, dir: path.join(profileRoot, d.name), mtime };
        })
        .filter((s) => s.mtime > 0)
        .sort((a, b) => b.mtime - a.mtime);
      if (subs.length) {
        const best = subs[0];
        console.log(`[browser] Migrating most-recent login (${best.name}) → shared profile dir.`);
        // Recursive copy. Use fs.cpSync (Node 16.7+) — safe synchronous, preserves perms.
        fs.cpSync(best.dir, sharedDir, { recursive: true, force: false, errorOnExist: false });
      }
    }
  } catch (e) {
    console.warn('[browser] session-dir migration skipped:', e?.message || e);
  }
  return sharedDir;
}

// Chromium leaves SingletonLock / SingletonCookie / SingletonSocket files
// behind when killed abruptly.  Remove them so the next launch succeeds.
// ── Finding a Chrome that is ALREADY running for this profile ────────────────
//
// The `lazy` map below is in-memory. Next.js restarts the server process on almost
// any edit, and module state resets with it — but YOUR CHROME KEEPS RUNNING. Once the
// map was empty, nothing knew the browser existed, so a scan would:
//   1. skip the "reuse the open Chrome" branch,
//   2. clearSingletons() — deleting the *live* Chrome's SingletonLock,
//   3. spawn a second Chrome on the same dir, which hands off to the running instance
//      and immediately exits,
//   4. time out waiting for CDP and fall back to Playwright's bundled Chromium —
//      a different browser with an empty profile and none of your cookies.
//
// That is why LinkedIn and Naukri behaved as though you were logged out while your
// real Chrome held valid li_at / nauk_sid cookies the whole time.
//
// The cure is to record the debug port on DISK and rediscover it, so the browser can
// be found by any future server process.
const PORT_FILE = '.jobfinder-cdp.json';

// ── Where a BACKGROUND scan runs ─────────────────────────────────────────────
//
// Its own user-data-dir, deliberately not the one your login window uses.
//
// Chrome allows exactly one process per user-data-dir. If a background scan held
// `main`, then clicking "Open & log in" mid-scan would find that process and hand
// your login window to a HEADLESS browser — you would click the button and nothing
// would ever appear. Separate directories mean the scan and your own window can
// never contend, whichever starts first.
//
// The cost is that the scan dir has no logins of its own, which is what
// syncScanCookies() below is for.
// The two things that give a headless Chrome away instantly.
//
// Measured on this machine, headless vs headful, same stealth script:
//     navigator.userAgent  ->  "...HeadlessChrome/151.0.0.0..."   vs  "...Chrome/151..."
//     screen               ->  800x600                            vs  1280x960
//
// Both are enough on their own. With them uncorrected, Naukri's Akamai returned
// "Access Denied" and Reddit returned zero posts, while the same code in a visible
// window got 24 and 10. Neither is a subtle behavioural signal — they are just the
// defaults nobody overrode.
let _uaCache = null;
function realUserAgent(browserPath) {
  if (_uaCache) return _uaCache;
  let major = '';
  try {
    const out = require('node:child_process')
      .execFileSync(browserPath, ['--version'], { timeout: 5000 })
      .toString();
    major = (out.match(/(\d+)\./) || [])[1] || '';
  } catch { /* fall through to a sane default */ }
  if (!major) return null;
  _uaCache =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  return _uaCache;
}

// Headless reports an 800x600 screen no matter what --window-size says, because there
// is no display behind it. Sites compare screen against window; 800x600 with a
// 1440x900 window is impossible on a real machine.
const HEADLESS_SCREEN_PATCH = `
(() => {
  const dims = { width: 1440, height: 900, availWidth: 1440, availHeight: 875 };
  for (const [k, v] of Object.entries(dims)) {
    try { Object.defineProperty(screen, k, { get: () => v, configurable: true }); } catch (e) {}
  }
})();
`;

function scanDir(profileId) {
  const dir = path.join(process.cwd(), 'data', 'sessions', profileId, 'scan');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Give the background scan the logins you established in your own window.
 *
 * Two routes, because the cookies live in a different place depending on whether
 * your Chrome is currently running:
 *
 *   • running  — read them over CDP from the live browser. Authoritative, and picks
 *                up a login you completed seconds ago that Chrome has not yet
 *                flushed to disk.
 *   • idle     — copy the on-disk cookie store. Chrome encrypts it with a key held
 *                in the login keychain and referenced from "Local State", so both
 *                files have to travel together or the copy decrypts to nothing.
 *
 * Best-effort by design: a scan with no cookies still returns everything from the
 * ~20 sources that need no login, so a failure here must never abort the scan.
 */
async function syncScanCookies(profileId, ctx, runningPort, stealth) {
  if (runningPort) {
    try {
      const pwLib = stealth ? require('rebrowser-playwright') : require('playwright');
      const browser = await pwLib.chromium.connectOverCDP(`http://127.0.0.1:${runningPort}`);
      try {
        const src = browser.contexts()[0];
        const cookies = src ? await src.cookies() : [];
        if (cookies.length) {
          await ctx.addCookies(cookies);
          console.log(`[browser] Background scan borrowed ${cookies.length} cookies from your open Chrome — your logins come with it`);
          return cookies.length;
        }
      } finally {
        // Disconnects this CDP client only. Your Chrome keeps running.
        await browser.close().catch(() => {});
      }
    } catch (e) {
      console.warn(`[browser] Could not copy cookies from your open Chrome (${e?.message || e}) — scanning logged-out sources only.`);
      return 0;
    }
  }

  const from = sessionDir(profileId);
  const to = scanDir(profileId);
  if (lockOwnerPid(from)) return 0;          // someone holds it — don't read a live store
  let copied = 0;
  for (const rel of [['Local State'], ['Default', 'Cookies']]) {
    try {
      const srcPath = path.join(from, ...rel);
      if (!fs.existsSync(srcPath)) continue;
      const dstPath = path.join(to, ...rel);
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
      fs.copyFileSync(srcPath, dstPath);
      copied++;
    } catch { /* best-effort */ }
  }
  return copied;
}

function writePortFile(userDataDir, port, pid) {
  try {
    fs.writeFileSync(path.join(userDataDir, PORT_FILE), JSON.stringify({ port, pid, at: Date.now() }));
  } catch { /* non-fatal — discovery just falls back to probing */ }
}

function readPortFile(userDataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(userDataDir, PORT_FILE), 'utf8'));
  } catch { return null; }
}

// Chrome symlinks SingletonLock to "<host>-<pid>" while it owns the directory. If that
// PID is alive, a Chrome is holding this profile and we must not disturb it.
function lockOwnerPid(userDataDir) {
  try {
    const target = fs.readlinkSync(path.join(userDataDir, 'SingletonLock'));
    const pid = Number((String(target).match(/-(\d+)$/) || [])[1]);
    if (!pid) return 0;
    try { process.kill(pid, 0); return pid; } catch { return 0; } // ESRCH → stale lock
  } catch { return 0; }
}

/** Is a CDP endpoint answering on this port? */
async function cdpAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

/**
 * Find a running Chrome for this profile, whether or not this process launched it.
 * Returns the debug port, or 0.
 */
export async function discoverRunningChrome(profileId) {
  // a) this process launched it and still remembers
  const mem = lazy.get(profileId);
  if (mem && mem.child && mem.child.exitCode === null && (await cdpAlive(mem.port))) return mem.port;

  const userDataDir = sessionDir(profileId);
  if (!lockOwnerPid(userDataDir)) return 0; // nobody owns the directory

  // b) a previous server process launched it — the port file survives restarts
  const rec = readPortFile(userDataDir);
  if (rec?.port && (await cdpAlive(rec.port))) return rec.port;

  // c) last resort: the ports this app hands out are a small known range
  for (let port = 9222; port <= 9240; port++) {
    if (await cdpAlive(port)) return port;
  }
  return 0;
}

function clearSingletons(userDataDir) {
  // Refuse to touch the lock files of a Chrome that is actually running — deleting
  // them out from under it is what produced windows appearing and vanishing mid-scan.
  const pid = lockOwnerPid(userDataDir);
  if (pid) {
    console.warn(`[browser] Chrome (pid ${pid}) is holding ${userDataDir} — leaving its lock files alone.`);
    return false;
  }
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const f = path.join(userDataDir, name);
    try { if (fs.existsSync(f) || fs.lstatSync(f, { throwIfNoEntry: false })) fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  return true;
}

async function isAlive(context) {
  if (!context) return false;
  try {
    context.pages();
    await context.cookies().catch(() => { throw new Error('dead'); });
    return true;
  } catch {
    return false;
  }
}

/** Allocate a unique debugging port per profile+connector key. */
function portForKey(key) {
  if (portMap.has(key)) return portMap.get(key);
  const port = nextPort++;
  portMap.set(key, port);
  return port;
}

/** Wait for the CDP endpoint to become available. */
async function waitForCDP(port, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

/** Launch a real browser as a child process and connect via CDP. */
async function launchRealBrowser(browserPath, userDataDir, port, headless, stealth = true, { offscreen = false } = {}) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // ── Anti-detection ──────────────────────────────────────────────
    '--disable-blink-features=AutomationControlled',
    // (Deliberately NOT disabling site-isolation — that would break Google OAuth.)
    '--disable-features=AutomationControlled,Translate',
    '--disable-infobars',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    '--lang=en-US,en',
  ];

  if (offscreen) {
    // BACKGROUND MODE.
    //
    // This used to pass --window-position=-32000,-32000 and claim the window was
    // invisible. It never was. macOS clamps a window to stay on screen, and measured
    // here the "off-screen" scan window came back at left=198, top=31 — squarely in
    // front of whatever you were doing. Every other way of hiding it was tried and
    // macOS refuses all of them:
    //
    //     Browser.setWindowBounds left:-32000  ->  clamped to -1202 (still visible)
    //     Browser.setWindowBounds top:3000     ->  clamped to 31
    //     Browser.setWindowBounds minimized    ->  silently ignored, stays 'normal'
    //
    // So there is no such thing as a hidden headful window on this platform, and the
    // only honest way to scan without taking over the screen is not to have a window
    // at all. `headless` is set by the caller for that; the size is kept normal
    // because it is still part of the fingerprint.
    args.push('--window-size=1440,900');
  } else {
    // VISIBLE MODE: for login + apply windows the user actively interacts with.
    args.push(
      '--start-maximized',
      '--window-size=1440,900',
    );
  }
  if (headless) {
    args.push('--headless=new');
    // Strip "HeadlessChrome" out of both the JS UA and the HTTP request header.
    const ua = realUserAgent(browserPath);
    if (ua) args.push(`--user-agent=${ua}`);
  }

  const child = spawn(browserPath, args, {
    stdio: 'ignore',
    detached: false,
  });

  // Don't let a dying child crash the Node process.
  child.on('error', () => {});

  const ready = await waitForCDP(port);
  if (!ready) {
    child.kill();
    throw new Error(`CDP not reachable on port ${port} after timeout`);
  }

  // Use rebrowser-playwright when stealth is ON, vanilla playwright when OFF.
  // rebrowser hides the CDP attachment fingerprint Cloudflare looks for, but its
  // isolated-world patches can trip on tabs that close mid-instrumentation. When
  // stealth is OFF the user wants a pristine Chrome window for solving CAPTCHAs
  // manually — no patches, no instrumentation, no observer.
  const pwLib = stealth ? require('rebrowser-playwright') : require('playwright');
  const browser = await pwLib.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];

  return { browser, context, childProcess: child };
}

/** Fallback: use rebrowser-playwright's bundled Chromium first, then Firefox. */
// Same anti-detection logic applies to the fallback — use rebrowser to hide CDP
// when stealth is on, vanilla playwright (cleaner, no patches) when stealth is off.
async function launchFallback(userDataDir, headless, stealth = true) {
  const { firefox, chromium } = stealth ? require('rebrowser-playwright') : require('playwright');
  clearSingletons(userDataDir);

  // Real Chrome's UA for the running macOS, so the bundled Chromium doesn't out itself
  // as "Chromium/X" or "HeadlessChrome/X" in network requests.
  const chromeUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  try {
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      viewport: { width: 1280, height: 900 },
      userAgent: chromeUA,
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
      // Strip Playwright's automation flag so navigator.webdriver isn't forced back on
      // and chrome://version doesn't show "ControlledByAutomation".
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    console.log('[browser] Fallback → bundled Chromium (with stealth + Chrome UA)');
    return { browser: null, context, childProcess: null, isFirefox: false };
  } catch (err) {
    console.warn(`[browser] Bundled Chromium failed (${err.message}), trying Firefox...`);
    const context = await firefox.launchPersistentContext(userDataDir, {
      headless,
      viewport: { width: 1280, height: 900 },
    });
    console.log('[browser] Fallback → bundled Firefox (may fail Google OAuth)');
    return { browser: null, context, childProcess: null, isFirefox: true };
  }
}

/** Inject stealth + observer scripts into a context. */
async function applyScripts(context, profileId, { isFirefox = false, stealth = true, headless = false } = {}) {
  if (!stealth) {
    // Stealth OFF — explicit user override (e.g. solving a CAPTCHA manually).
    // Don't touch the page. No init scripts, no bindings, no instrumentation.
    return;
  }

  // 1. Stealth patches (runs before every navigation). Best-effort.
  try {
    await context.addInitScript({ content: isFirefox ? STEALTH_SCRIPT_FIREFOX : STEALTH_SCRIPT_CHROMIUM });
    // Headless has no display, so screen.* reports 800x600 and contradicts the window
    // size. Only patch when actually headless — faking it in a real window would
    // replace a true value with a false one.
    if (headless && !isFirefox) await context.addInitScript({ content: HEADLESS_SCREEN_PATCH });
  } catch (e) {
    console.warn('[browser] stealth init-script skipped:', e?.message || e);
  }

  // 2. Form-observer + autofill helpers init-script. CRITICAL for autofill — defines
  // window.__jobfinderFill and window.__jobfinderSetByPath that the autofill engine
  // calls via page.evaluate(). Always install, even if step 3 below fails.
  try {
    await context.addInitScript({ content: OBSERVER_SCRIPT });
  } catch (e) {
    console.warn('[browser] observer init-script FAILED — autofill will not work:', e?.message || e);
  }

  // 3. Binding for the observer to phone-home form values to the Node side. Separate
  // try/catch because exposeBinding can fail on contexts obtained via connectOverCDP
  // when a page has already opened. If this fails, autofill still works (since it
  // only uses the init-script functions); only the passive answer-harvesting is lost.
  try {
    await context.exposeBinding('__jobfinderObserve', async (_source, payload) => {
      try { await recordAnswer(profileId, payload || {}); } catch { /* ignore */ }
    });
  } catch (e) {
    console.warn('[browser] observer binding skipped (autofill still works, but typed answers won\'t auto-save):', e?.message || e);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

// `connector` is accepted for back-compat but is IGNORED for cache + dir purposes —
// every connector now shares ONE browser window per profile. This is what keeps the
// total open Chrome windows down to 1 (per profile), matches normal browsing
// behavior, and lets an organic cookie/history footprint accumulate for stealth.
//
// `offscreen`: run this context in the BACKGROUND — headless, in its own user-data-dir
// seeded with a copy of your cookies. Scanning uses it; login and apply windows do not,
// because you need to see and click those.
//
// The name is historical. It used to mean "a real window, parked off-screen", which
// macOS never actually allowed (see launchRealBrowser). Background scanning now means
// no window at all, which is the only version of this that works.
export async function getContext(profileId, connector, { headless = false, stealth = true, offscreen = false } = {}) {
  // Cache key is per-profile + stealth + visibility. Reusing an offscreen context
  // for a login flow would leave the window invisible, so visibility is part of key.
  const key = `${profileId}::${stealth ? 'S' : 'N'}::${offscreen ? 'O' : 'V'}`;

  // 1) Reuse a healthy live context — common path.
  const existing = live.get(key);
  if (existing && (await isAlive(existing.context))) {
    // The scan browser copied your cookies when it started, and it outlives a single
    // scan. So a sign-in you complete AFTER it started — including one it just asked
    // you for — would never reach it, and the next scan would ask again in a loop.
    // Re-copy them, throttled: getContext runs once per connector, and re-syncing a
    // dozen times per scan would attach to your Chrome a dozen times for nothing.
    if (offscreen && Date.now() - (existing.cookiesAt || 0) > 60000) {
      existing.cookiesAt = Date.now();
      try {
        const port = await discoverRunningChrome(profileId);
        if (port) await syncScanCookies(profileId, existing.context, port, stealth);
      } catch { /* best-effort: a stale cookie set still scans public sources */ }
    }
    return existing.context;
  }

  // 2) De-dupe concurrent launches so two parallel requests don't both miss the cache
  //    and spawn competing Chromes fighting over one user-data-dir.
  if (launching.has(key)) return launching.get(key);

  const p = launchContext(profileId, key, { headless, stealth, offscreen })
    .finally(() => { launching.delete(key); });
  launching.set(key, p);
  return p;
}

// Internal: performs the actual (serialized) launch for one key.
async function launchContext(profileId, key, { headless, stealth, offscreen }) {
  // Drop a dead entry for this key if one lingered.
  const existing = live.get(key);
  if (existing) {
    try { existing.childProcess?.kill(); } catch { /* ignore */ }
    live.delete(key);
  }

  // ── Reuse the login/apply Chrome if one is already running ────────────────
  //
  // Chrome allows exactly ONE process per user-data-dir, and both mechanisms in
  // this file point at sessionDir(profileId):
  //   • `lazy`  — the window opened by "Open & log in" / Apply
  //   • `live`  — the context Scan asks for here
  //
  // Spawning a second Chrome on that directory doesn't give you a second browser:
  // the new process hands off to the running one and immediately exits, so
  // waitForCDP times out and we silently fall back to Playwright's bundled
  // Chromium — a different browser with none of the user's logins. Worse, the
  // clearSingletons() below would delete the *live* lock file of the running
  // Chrome. That combination is what produced windows appearing and vanishing
  // mid-scan, and logged-in sources returning nothing.
  //
  // So if a lazy Chrome is up, attach to ITS debug port instead of competing.
  // Discovery is on-disk, so this works even when a server restart wiped `lazy` —
  // which is the common case, and was the reason logged-in sources looked logged out.
  const runningPort = await discoverRunningChrome(profileId);
  // A background scan deliberately does NOT borrow your open window. Borrowing is
  // what put scan tabs in front of you: every connector called ctx.newPage() and each
  // one landed in the window you were looking at. It runs headless in its own
  // directory instead, and takes a copy of your cookies (below) so it stays logged in.
  if (runningPort && !offscreen) {
    try {
      const pwLib = stealth ? require('rebrowser-playwright') : require('playwright');
      const browser = await pwLib.chromium.connectOverCDP(`http://127.0.0.1:${runningPort}`);
      const ctx = browser.contexts()[0];
      if (ctx) {
        console.log(`[browser] Reusing your open Chrome for ${profileId} (port ${runningPort}) — your logins come with it`);
        await applyScripts(ctx, profileId, { isFirefox: false, stealth });
        // `browser` here is only a CDP client; closing it disconnects but leaves
        // the user's Chrome running, which is what we want.
        const entry = { context: ctx, browser, childProcess: null, borrowed: true };
        live.set(key, entry);
        ctx.on('close', () => { live.delete(key); });
        return ctx;
      }
      await browser.close().catch(() => {});
    } catch (e) {
      console.warn(`[browser] Could not attach to the open Chrome (${e?.message || e}); launching a fresh one.`);
    }
  }

  // Tear down any sibling that would fight for the SAME directory — only one Chrome
  // process per user-data-dir is allowed. Background (O) and visible (V) now live in
  // different directories, so they are NOT siblings and must both be left running;
  // killing the visible one here would close the window you are logging in with.
  const vis = offscreen ? 'O' : 'V';
  for (const otherKey of [`${profileId}::S::${vis}`, `${profileId}::N::${vis}`]) {
    if (otherKey === key) continue;
    const sibling = live.get(otherKey);
    if (sibling) {
      try { await sibling.context.close(); } catch { /* ignore */ }
      try { sibling.childProcess?.kill(); } catch { /* ignore */ }
      live.delete(otherKey);
    }
  }

  const userDataDir = offscreen ? scanDir(profileId) : sessionDir(profileId);
  // Only safe now: we've established no Chrome is holding this directory.
  clearSingletons(userDataDir);

  let entry;
  if (_detected) {
    const port = portForKey(key);
    try {
      console.log(`[browser] Launching ${_detected.name} via CDP on port ${port} (stealth=${stealth ? 'ON' : 'OFF'}, ${offscreen ? 'off-screen' : 'visible'})`);
      entry = await launchRealBrowser(_detected.path, userDataDir, port, headless, stealth, { offscreen });
      // Same durable record as the lazy path, so this Chrome is rediscoverable too.
      writePortFile(userDataDir, port, entry?.childProcess?.pid || 0);
    } catch (err) {
      console.warn(`[browser] Real browser launch failed (${err.message}), falling back to Playwright`);
      entry = await launchFallback(userDataDir, headless, stealth);
    }
  } else {
    console.log(`[browser] No real browser detected — using Playwright Fallback (stealth=${stealth ? 'ON' : 'OFF'})`);
    entry = await launchFallback(userDataDir, headless, stealth);
  }

  await applyScripts(entry.context, profileId, { isFirefox: entry.isFirefox, stealth, headless });

  // The scan directory starts with no logins of its own — hand it yours.
  if (offscreen) {
    entry.cookiesAt = Date.now();
    try { await syncScanCookies(profileId, entry.context, runningPort, stealth); }
    catch (e) { console.warn('[browser] cookie sync for background scan failed:', e?.message || e); }
  }

  live.set(key, entry);
  entry.context.on('close', () => {
    try { entry.childProcess?.kill(); } catch { /* ignore */ }
    live.delete(key);
  });
  return entry.context;
}

/**
 * Open the ONE browser window for this (profile, connector) and point it at the
 * login URL so the user can sign in / solve any human-check.
 *
 * Crucially this is the SAME context that Scan and Apply use — it comes from
 * getContext() and is cached in `live`. The user logs in here, the window stays
 * open, and the subsequent Scan reuses this exact live session. There is no second
 * window and no cookie-handoff to fail: it's literally the same browser.
 *
 * We deliberately do NOT close it afterwards. Closing + relaunching for the scan
 * was the old broken design that forced a re-login.
 */
export async function openLogin(profileId, connector, url, { stealth = true } = {}) {
  const ctx = await getContext(profileId, connector, { headless: false, stealth });

  // Always open the login URL in a NEW tab — that way an existing logged-in
  // tab for another site stays put. If no tabs exist, this creates the first one.
  const page = await ctx.newPage();

  if (url) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch { /* slow site / redirect — the user can still navigate manually */ }
  }
  try { await page.bringToFront(); } catch { /* best-effort focus */ }

  return { ok: true, browser: _detected?.name || 'Chromium' };
}

// ── LAZY-ATTACH model ─────────────────────────────────────────────────────────
//
// Apply + autofill use this. Chrome runs continuously with --remote-debugging-port
// open but NO Playwright client connected. Web JS can't probe localhost:port across
// origins, and Chrome only sets navigator.webdriver=true when a CDP client actively
// issues Runtime.enable — so the window is JS-fingerprint-identical to plain Chrome.
//
// withAttachedContext() attaches Playwright transiently (~100ms), runs the callback,
// then disconnects. Browser process stays alive. Pages opened/loaded between attaches
// don't get init scripts, which is GOOD for the verification step that comes AFTER
// autofill — fewer instrumentation signals for the bot detector to find.

function lazyAlive(profileId) {
  const e = lazy.get(profileId);
  if (!e) return false;
  // Probe the debug port to confirm Chrome is still up.
  return e.child && !e.child.killed && e.child.exitCode === null;
}

/**
 * Open a URL in the profile's lazy-attach Chrome window. If the window doesn't yet
 * exist, spawn it with the debug port enabled (but no Playwright connected). If it
 * already exists, send the URL via a second Chrome invocation — Chrome's single-
 * instance behavior opens it as a new tab in the existing process.
 *
 * Returns immediately; doesn't wait for the page to load.
 */
export async function openInChrome(profileId, url) {
  const browserPath = _detected?.path;
  if (!browserPath) {
    throw new Error('Real Chrome not installed. Install it with: brew install --cask google-chrome');
  }

  // Already running? Just send the URL — Chrome adds it as a new tab in the existing
  // process (the second `--user-data-dir=X chrome ...` invocation is intercepted).
  const already = await discoverRunningChrome(profileId);
  if (already) {
    const proc = lazy.get(profileId) || { port: already, userDataDir: sessionDir(profileId) };
    const child = spawn(browserPath, [`--user-data-dir=${proc.userDataDir}`, url || 'about:blank'], {
      stdio: 'ignore', detached: true,
    });
    child.unref();
    child.on('error', () => {});
    return { ok: true, openedNewTab: true, port: proc.port || already };
  }

  // If a SCAN context is attached to this profile, tear it down first — Chrome only
  // allows one process per user-data-dir.
  await closeAllForProfile(profileId);

  const userDataDir = sessionDir(profileId);
  clearSingletons(userDataDir);
  const port = nextPort++;

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // ── Anti-detection: same flags as the attached launch, even without a Playwright
    //    client these don't hurt and they make the browser look more "normal".
    '--disable-blink-features=AutomationControlled',
    '--disable-features=AutomationControlled,Translate',
    '--disable-infobars',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    '--start-maximized',
    '--window-size=1440,900',
    '--lang=en-US,en',
    url || 'about:blank',
  ];
  const child = spawn(browserPath, args, { stdio: 'ignore', detached: false });
  child.on('error', () => {});

  // Wait until the debug port responds so a quick Autofill click right after Apply
  // doesn't race the Chrome startup.
  const ready = await waitForCDP(port);
  if (!ready) {
    try { child.kill(); } catch { /* ignore */ }
    throw new Error(`Chrome started but CDP port ${port} not reachable`);
  }

  lazy.set(profileId, { port, child, userDataDir });
  // Persist the port so a future server process can find this Chrome again.
  writePortFile(userDataDir, port, child.pid);
  child.on('exit', () => {
    if (lazy.get(profileId)?.child === child) lazy.delete(profileId);
  });
  console.log(`[browser] Lazy-attach Chrome running for ${profileId} on port ${port} (no Playwright connected)`);
  return { ok: true, openedNewTab: false, port };
}

/**
 * Attach Playwright transiently to the profile's lazy-attach Chrome, run `fn(ctx)`,
 * then detach. The Chrome process keeps running.
 *
 * `fn` receives the BrowserContext exactly like the old getContext flow. Before
 * calling fn, we inject the observer + stealth scripts into every already-open page
 * (addInitScript only fires on FUTURE navigations, so existing tabs need a manual
 * evaluate). After fn finishes, we disconnect Playwright — clearing exposeBinding,
 * removing the live CDP-client signals that ATSes detect during verification.
 */
export async function withAttachedContext(profileId, fn) {
  // Rediscover from disk first — a server restart empties `lazy` while your Chrome
  // (and its logged-in sessions) is still very much alive.
  const foundPort = await discoverRunningChrome(profileId);
  const proc = foundPort ? { port: foundPort } : null;
  if (!proc) {
    throw new Error('No browser open for this profile. Click Apply on a job (or use "Open & log in") to open one first.');
  }

  const pwLib = require('rebrowser-playwright');
  const browser = await pwLib.chromium.connectOverCDP(`http://127.0.0.1:${proc.port}`);
  const ctx = browser.contexts()[0];
  if (!ctx) {
    await browser.close().catch(() => {});
    throw new Error('Chrome is running but has no browser context (window may be mid-startup).');
  }

  try {
    // 1) Install stealth + observer for any FUTURE navigations during this attach.
    await applyScripts(ctx, profileId, { isFirefox: false, stealth: true });

    // 2) Inject helpers into already-open pages too — addInitScript doesn't cover
    //    them. OBSERVER_SCRIPT and STEALTH_SCRIPT_CHROMIUM are self-invoking IIFEs
    //    with an "already-installed" guard, so re-injection is a safe no-op.
    for (const page of ctx.pages()) {
      if (page.isClosed()) continue;
      for (const frame of page.frames()) {
        try {
          await frame.evaluate(STEALTH_SCRIPT_CHROMIUM);
          await frame.evaluate(OBSERVER_SCRIPT);
        } catch { /* frame may be navigating, cross-origin without our reach, etc. */ }
      }
    }

    // Re-arm the in-page toolbar while we're here — a navigation since the last
    // attach would have wiped it, and this is the cheapest moment to restore it.
    try {
      const { injectToolbar } = await import('./injectToolbar.js');
      await injectToolbar(ctx);
    } catch { /* non-fatal */ }

    return await fn(ctx);
  } finally {
    // Disconnect Playwright but leave Chrome alive. browser.close() on a
    // connectOverCDP browser only closes the client side per Playwright docs.
    await browser.close().catch(() => {});
  }
}

/**
 * SAFE MODE — instantly convert the automated Chrome to a plain Chrome window with
 * zero automation attached. Use this if a "verify you are human" check is escalating
 * and you don't want any chance of being flagged.
 *
 * What it does:
 *   1. Snapshots the URLs of every open tab in the current automated context.
 *   2. Closes the automated context (cookies flush to the user-data-dir on disk).
 *   3. Launches a brand-new Chrome process on the SAME user-data-dir with NO
 *      --remote-debugging-port and NO init scripts. The site sees an ordinary user
 *      browser — there is literally nothing to detect because nothing is attached.
 *   4. Reopens the same URLs as tabs. Your logins / cookies / cf_clearance carry over
 *      because they live in the user-data-dir, not the Chrome process.
 *
 * When the user closes the safe window, the next Scan/Apply will spin automated mode
 * back up on the same dir, inheriting whatever fresh cookies were set.
 */
export async function switchToSafeMode(profileId) {
  // Safe Mode's whole purpose is that nothing is attached — drop the toolbar keeper
  // along with everything else. The toolbar disappears; the bookmarklet still works.
  try {
    const { stopKeeper } = await import('./toolbarKeeper.js');
    stopKeeper(profileId);
  } catch { /* non-fatal */ }

  const browserPath = _detected?.path;
  if (!browserPath) {
    throw new Error('Real Chrome not installed. Install it with: brew install --cask google-chrome');
  }

  // 1) Capture URLs from whichever Chrome is currently live for this profile:
  //    - attached scan windows (any stealth × visibility variant)
  //    - lazy-attach Apply window (requires a transient CDP attach to read tabs)
  const urls = [];
  for (const key of [
    `${profileId}::S::V`, `${profileId}::S::O`,
    `${profileId}::N::V`, `${profileId}::N::O`,
  ]) {
    const entry = live.get(key);
    if (!entry) continue;
    for (const p of entry.context.pages()) {
      if (p.isClosed()) continue;
      const u = p.url();
      if (u && u !== 'about:blank' && !u.startsWith('chrome://')) urls.push(u);
    }
  }
  // Lazy-attach: connect briefly, snapshot URLs, disconnect — we're about to kill
  // this Chrome anyway in step 2.
  const lazyEntry = lazy.get(profileId);
  if (lazyEntry) {
    try {
      const pwLib = require('rebrowser-playwright');
      const b = await pwLib.chromium.connectOverCDP(`http://127.0.0.1:${lazyEntry.port}`);
      const c = b.contexts()[0];
      if (c) for (const p of c.pages()) {
        if (p.isClosed()) continue;
        const u = p.url();
        if (u && u !== 'about:blank' && !u.startsWith('chrome://')) urls.push(u);
      }
      await b.close().catch(() => {});
    } catch { /* lazy Chrome may have died — fine */ }
  }

  // 2) Close all automated contexts for this profile so the user-data-dir is free.
  await closeAllForProfile(profileId);

  // Brief pause — Chrome takes a moment to release the SingletonLock + flush cookies.
  await new Promise((r) => setTimeout(r, 700));

  const userDataDir = sessionDir(profileId);
  clearSingletons(userDataDir);

  // 3) Launch plain Chrome. NO debugging port, NO automation flags. This window is
  //    indistinguishable from the user's own Chrome to any bot detector.
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    '--window-size=1440,900',
    '--lang=en-US,en',
    ...(urls.length ? urls : ['about:blank']),
  ];
  const child = spawn(browserPath, args, { stdio: 'ignore', detached: true });
  child.unref();
  child.on('error', () => {});

  return {
    ok: true,
    browser: _detected.name,
    restoredTabs: urls.length,
    note: urls.length
      ? `Reopened ${urls.length} tab${urls.length === 1 ? '' : 's'} in a clean Chrome window — finish your application there. When you close it, the next Scan/Apply will resume automation with your updated cookies.`
      : 'Opened a clean Chrome window — no automation attached. Close it when done; automated mode resumes on the next Scan/Apply.',
  };
}

/** Close every live context AND every lazy Chrome process belonging to a profile. */
export async function closeAllForProfile(profileId) {
  const toClose = [];
  for (const [key, entry] of live.entries()) {
    if (key.startsWith(`${profileId}::`)) toClose.push({ key, entry });
  }
  for (const { key, entry } of toClose) {
    if (entry.borrowed) {
      // We attached to a Chrome we did NOT spawn (the user's login window).
      // Disconnect the CDP client only — calling context.close() here would shut
      // their tabs, and killing the process would close the window they're using.
      try { await entry.browser?.close(); } catch { /* ignore */ }
    } else {
      try { await entry.context.close(); } catch { /* ignore */ }
      try { entry.childProcess?.kill(); } catch { /* ignore */ }
    }
    live.delete(key);
  }
  // Also kill the lazy-attach Chrome (the one Apply opened with debug port but no
  // Playwright client). Otherwise switching to Safe Mode would leave two Chromes
  // fighting over the user-data-dir.
  const lazyEntry = lazy.get(profileId);
  if (lazyEntry) {
    try { lazyEntry.child?.kill(); } catch { /* ignore */ }
    lazy.delete(profileId);
  }
  return toClose.length + (lazyEntry ? 1 : 0);
}

export async function closeContext(profileId, _connector) {
  // Connectors share ONE context per profile now, so `_connector` is ignored — we
  // close every stealth × visibility variant that happens to be open for this profile.
  for (const key of [
    `${profileId}::S::V`, `${profileId}::S::O`,
    `${profileId}::N::V`, `${profileId}::N::O`,
  ]) {
    const existing = live.get(key);
    if (!existing) continue;
    // Borrowed = attached to the user's own Chrome; only drop the client.
    if (!existing.borrowed) await existing.context.close().catch(() => {});
    try { existing.browser?.close(); } catch { /* ignore */ }
    if (!existing.borrowed) { try { existing.childProcess?.kill(); } catch { /* ignore */ } }
    live.delete(key);
  }
}

export function hasSession(profileId, connector) {
  const p = path.join(process.cwd(), 'data', 'sessions', profileId, connector);
  return fs.existsSync(path.join(p, 'Default')) || fs.existsSync(path.join(p, 'Cookies'));
}
