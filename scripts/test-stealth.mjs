// Verify the stealth init-script defeats the fingerprint checks that commercial
// bot-detectors (Cloudflare, DataDome, PerimeterX, Kasada) actually run.
//
// Usage: node scripts/test-stealth.mjs
//
// Each probe returns { pass, got } and we print a PASS/FAIL table. This runs against
// a REAL Chrome via the same launch path the app uses, so it tests the real thing.

import fs from 'node:fs';
import path from 'node:path';

process.chdir(path.resolve(import.meta.dirname, '..'));

// Pull the stealth script straight out of browser.js so the test can never drift
// from what the app actually injects.
const src = fs.readFileSync('lib/browser.js', 'utf8');
const m = src.match(/const STEALTH_SCRIPT_CHROMIUM = `([\s\S]*?)\n`;/);
if (!m) {
  console.error('✗ Could not extract STEALTH_SCRIPT_CHROMIUM from lib/browser.js');
  process.exit(1);
}
const STEALTH = m[1];

const { chromium } = await import('rebrowser-playwright');

const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=AutomationControlled',
  ],
});
const ctx = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  locale: 'en-US',
});
await ctx.addInitScript({ content: STEALTH });
const page = await ctx.newPage();
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

const probes = await page.evaluate(() => {
  const out = {};
  const src = (fn) => { try { return Function.prototype.toString.call(fn); } catch (e) { return 'THREW: ' + e.message; } };
  const isNative = (s) => /\{\s*\[native code\]\s*\}/.test(s);

  // ── The classic checks ────────────────────────────────────────────────
  // Real non-automated Chrome: property EXISTS and is false.
  out['navigator.webdriver === false'] = {
    pass: navigator.webdriver === false,
    got: String(navigator.webdriver),
  };
  out["'webdriver' in navigator === true"] = {
    pass: ('webdriver' in navigator) === true,
    got: String('webdriver' in navigator),
  };

  const wdDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
  out['webdriver getter reports [native code]'] = {
    pass: wdDesc && wdDesc.get ? isNative(src(wdDesc.get)) : false,
    got: wdDesc && wdDesc.get ? src(wdDesc.get).slice(0, 60) : '(no descriptor)',
  };

  const plDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'plugins');
  out['plugins getter reports [native code]'] = {
    pass: plDesc && plDesc.get ? isNative(src(plDesc.get)) : false,
    got: plDesc && plDesc.get ? src(plDesc.get).slice(0, 60) : '(no descriptor)',
  };

  out['toString itself reports [native code]'] = {
    pass: isNative(src(Function.prototype.toString)),
    got: src(Function.prototype.toString).slice(0, 60),
  };

  // Un-patched natives must be untouched (over-broad masking is itself a signal).
  out['unpatched native still native (Array.isArray)'] = {
    pass: isNative(src(Array.isArray)),
    got: src(Array.isArray).slice(0, 60),
  };
  // A plain user function must NOT be masked.
  const userFn = function hello() { return 1; };
  out['plain user fn NOT masked'] = {
    pass: !isNative(src(userFn)),
    got: src(userFn).slice(0, 40),
  };

  // ── Identity stability (the old code failed this) ──────────────────────
  out['navigator.plugins identity stable'] = {
    pass: navigator.plugins === navigator.plugins,
    got: String(navigator.plugins === navigator.plugins),
  };
  out['navigator.plugins[0] identity stable'] = {
    pass: navigator.plugins[0] === navigator.plugins[0],
    got: String(navigator.plugins[0] === navigator.plugins[0]),
  };
  out['plugins.length > 0'] = {
    pass: navigator.plugins.length > 0,
    got: String(navigator.plugins.length),
  };
  out['plugins instanceof PluginArray'] = {
    pass: navigator.plugins instanceof PluginArray,
    got: String(navigator.plugins instanceof PluginArray),
  };
  out['mimeTypes instanceof MimeTypeArray'] = {
    pass: navigator.mimeTypes instanceof MimeTypeArray,
    got: String(navigator.mimeTypes instanceof MimeTypeArray),
  };
  out['plugins[0] instanceof Plugin'] = {
    pass: navigator.plugins[0] instanceof Plugin,
    got: String(navigator.plugins[0] instanceof Plugin),
  };

  // ── window.chrome surface ─────────────────────────────────────────────
  out['window.chrome exists'] = { pass: !!window.chrome, got: typeof window.chrome };
  out['chrome.runtime exists'] = { pass: !!(window.chrome && window.chrome.runtime), got: typeof (window.chrome || {}).runtime };
  out['chrome.app exists'] = { pass: !!(window.chrome && window.chrome.app), got: typeof (window.chrome || {}).app };
  out['chrome.csi is fn'] = { pass: typeof (window.chrome || {}).csi === 'function', got: typeof (window.chrome || {}).csi };
  out['chrome.loadTimes is fn'] = { pass: typeof (window.chrome || {}).loadTimes === 'function', got: typeof (window.chrome || {}).loadTimes };

  // ── Consistency checks ────────────────────────────────────────────────
  out['languages non-empty'] = { pass: navigator.languages.length > 0, got: JSON.stringify(navigator.languages) };
  out['hardwareConcurrency >= 2'] = { pass: navigator.hardwareConcurrency >= 2, got: String(navigator.hardwareConcurrency) };

  // ── WebGL ─────────────────────────────────────────────────────────────
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : 37445);
    const renderer = gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : 37446);
    out['WebGL vendor not SwiftShader'] = {
      pass: !/swiftshader|mesa|llvmpipe/i.test(String(vendor) + String(renderer)),
      got: vendor + ' / ' + String(renderer).slice(0, 40),
    };
  } catch (e) {
    out['WebGL vendor not SwiftShader'] = { pass: false, got: 'threw: ' + e.message };
  }

  // ── Automation artifacts ──────────────────────────────────────────────
  const leaked = Object.keys(window).filter((k) => /^(cdc_|__webdriver|__selenium|__driver|__fxdriver|_Selenium)/.test(k));
  out['no cdc_/webdriver window keys'] = { pass: leaked.length === 0, got: leaked.join(',') || '(none)' };

  return out;
});

// Permissions check needs async
const permOk = await page.evaluate(async () => {
  try {
    const st = await navigator.permissions.query({ name: 'notifications' });
    return { pass: !(st.state === 'denied' && Notification.permission === 'default'), got: st.state + ' / Notification.permission=' + Notification.permission };
  } catch (e) { return { pass: false, got: 'threw: ' + e.message }; }
});
probes['permissions/Notification not contradictory'] = permOk;

await browser.close();

let pass = 0; let fail = 0;
console.log('\n  STEALTH FINGERPRINT PROBES');
console.log('  ' + '─'.repeat(74));
for (const [name, r] of Object.entries(probes)) {
  const mark = r.pass ? '✅' : '❌';
  if (r.pass) pass++; else fail++;
  console.log('  ' + mark + ' ' + name.padEnd(44) + ' ' + String(r.got).slice(0, 26));
}
console.log('  ' + '─'.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);
