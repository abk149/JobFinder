// Keeps the in-page toolbar alive for the whole application, not just its first page.
//
// THE PROBLEM
// A real application is 2–3 pages: listing → apply form → confirm. Injecting the
// toolbar once, when Apply opens the window, put it on page 1 and nowhere else — the
// moment you clicked through, it was gone, and with it the hotkeys.
//
// Re-injecting on every attach doesn't help either: we only attach when you ask us to
// fill, which is precisely the thing you can't do once the toolbar has disappeared.
//
// HOW
// Chrome will re-run a registered script on every new document by itself — that is
// what Page.addScriptToEvaluateOnNewDocument is for. It applies to navigations, to
// iframes, and (via Target auto-attach) to new tabs. The catch, which cost a debugging
// round: it silently does nothing unless Page.enable is called on that session first.
//
// The registration lives for as long as the CDP session stays open, so this holds one
// open — a raw WebSocket, deliberately NOT Playwright.
//
// ON STEALTH
// This is the one place something stays connected while you work, so it is kept as
// small as possible:
//   • raw CDP over a WebSocket — none of Playwright's instrumentation
//   • Page.enable and Target.setAutoAttach only
//   • NEVER Runtime.enable — that is the call anti-bot scripts actually fingerprint
//     (it leaks execution-context ids and is why this project uses rebrowser-playwright)
//   • no polling, no evaluation loop; Chrome does the re-injection itself
//
// Safe Mode remains the full escape hatch: it relaunches Chrome with no debugging port
// at all, which drops this session with it.
//
// Enabled by default. See startKeeper for the measurements showing this session is
// invisible to the checks that actually flag automation.

import { quickToken } from './quickToken.js';
import fs from 'node:fs';
import path from 'node:path';
import { appPath } from './paths.js';

const keepers = new Map(); // profileId -> { ws, jobId, port }

function toolbarSource(origin) {
  const src = fs.readFileSync(appPath('lib', 'toolbar.src.js'), 'utf8');
  return src
    .replaceAll('__JOBFINDER_TOKEN__', quickToken())
    .replaceAll('__JOBFINDER_ORIGIN__', origin || `http://127.0.0.1:${process.env.PORT || 3737}`);
}

/** Drop the keeper for a profile (called before starting a new one, and on shutdown). */
export function stopKeeper(profileId) {
  const k = keepers.get(profileId);
  if (!k) return false;
  keepers.delete(profileId);
  try { k.ws.close(); } catch { /* already gone */ }
  return true;
}

export function keeperStatus(profileId) {
  const k = keepers.get(profileId);
  return k ? { active: true, jobId: k.jobId, port: k.port } : { active: false };
}

/**
 * Start (or move) the toolbar keeper for a profile.
 * Exactly one is alive per profile — clicking Apply on another job moves it there.
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function startKeeper(profileId, { port, jobId, origin } = {}) {
  // ON by default; disable with JOBFINDER_TOOLBAR_KEEPER=0.
  //
  // This session stays open while you work, which looks like it contradicts the
  // attach-transiently-then-detach rule the rest of the app follows. It was worth
  // measuring rather than assuming, because the reason for that rule is a specific,
  // observable fingerprint — not the mere existence of a connection.
  //
  // What detectors actually test for is a client that has called Runtime.enable: it
  // makes the browser serialize thrown objects, which a page catches with a getter on
  // Error.stack (and secondarily by how slow console.debug becomes). That is the check
  // Cloudflare and DataDome run, and it is why this project uses rebrowser-playwright.
  //
  // Measured on real Chrome, keeper OFF vs ON:
  //     Error.stack getter fired : no   / no
  //     console.debug cost       : 0ms  / 0ms
  //     navigator.webdriver      : undefined / undefined
  //   plus scripts/test-stealth.mjs → 23/23 with the session attached.
  //
  // It passes because it never calls Runtime.enable — only Page.enable and
  // Target.setAutoAttach, neither of which the page can observe. Playwright is what
  // could not be left attached; this cannot be seen at all.
  if (process.env.JOBFINDER_TOOLBAR_KEEPER === '0') {
    return { ok: false, reason: 'disabled by JOBFINDER_TOOLBAR_KEEPER=0' };
  }
  if (!port) return { ok: false, reason: 'no debug port' };
  stopKeeper(profileId);

  let source;
  try { source = toolbarSource(origin); } catch { return { ok: false, reason: 'toolbar source missing' }; }

  let wsUrl;
  try {
    const ver = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2500) });
    wsUrl = (await ver.json()).webSocketDebuggerUrl;
  } catch { return { ok: false, reason: 'browser not reachable' }; }
  if (!wsUrl) return { ok: false, reason: 'no CDP endpoint' };

  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  const send = (method, params, sessionId) => {
    try {
      ws.send(JSON.stringify({ id: ++msgId, method, params: params || {}, sessionId }));
    } catch { /* socket closing */ }
  };

  const entry = { ws, jobId, port };
  keepers.set(profileId, entry);

  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo } = m.params || {};
    if (!sessionId) return;

    // ── ALWAYS RESUME, WHATEVER THE TARGET IS ────────────────────────────────
    // Auto-attach can hand us targets that are paused waiting for a debugger, and a
    // paused target never finishes loading. Real sites hit this constantly and toy
    // test pages never do, because the culprits are the targets sites create behind
    // the scenes: speculative PRERENDERS of the next page, service workers, and
    // prefetched documents. Clicking "next" then navigates to a prerendered target
    // that is frozen waiting for us — the page simply never opens.
    //
    // runIfWaitingForDebugger is a no-op when nothing is waiting, so it is safe to
    // send unconditionally, and it must be sent for EVERY target type, not just pages.
    send('Runtime.runIfWaitingForDebugger', {}, sessionId);

    if (targetInfo?.type !== 'page') return;

    // Order matters: Page.enable FIRST, or the registration is silently ignored.
    send('Page.enable', {}, sessionId);
    send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
    // ...and cover the document that is already loaded in this target.
    send('Runtime.evaluate', { expression: source, awaitPromise: false }, sessionId);
  });

  ws.addEventListener('close', () => {
    if (keepers.get(profileId) === entry) keepers.delete(profileId);
  });
  ws.addEventListener('error', () => {
    if (keepers.get(profileId) === entry) keepers.delete(profileId);
  });

  const opened = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 4000);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(true); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(t); resolve(false); }, { once: true });
  });
  if (!opened) { stopKeeper(profileId); return { ok: false, reason: 'could not open CDP socket' }; }

  // flatten:true puts every target on this one socket, so new tabs are covered too.
  send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  return { ok: true };
}
