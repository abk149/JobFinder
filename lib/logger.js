// Per-profile in-memory log bus.
//
// Used by long-running flows (autofill, scan, apply) to emit structured progress
// lines that the UI's terminal panel subscribes to via SSE. The bus keeps a small
// rolling buffer per profile so a freshly-opened terminal can replay the last few
// lines instead of looking empty.
//
// Deliberately in-process and non-persistent — these are ephemeral progress traces,
// not audit logs.

const BUFFER_SIZE = 200;

// profileId -> { lines: [...], subscribers: Set<callback> }
const buses = new Map();

function bus(profileId) {
  let b = buses.get(profileId);
  if (!b) {
    b = { lines: [], subscribers: new Set() };
    buses.set(profileId, b);
  }
  return b;
}

/**
 * Emit a log line for a profile. `level` is one of:
 *   'info'   — neutral progress
 *   'ok'     — success (will render green)
 *   'warn'   — non-fatal issue (yellow)
 *   'error'  — failure (red)
 *   'cmd'    — user-triggered action header (blue, like a prompt)
 */
export function log(profileId, level, message, meta = null) {
  if (!profileId || !message) return;
  const entry = {
    id: ++seq,
    ts: Date.now(),
    level: String(level || 'info'),
    message: String(message),
    meta: meta || undefined,
  };
  const b = bus(profileId);
  b.lines.push(entry);
  if (b.lines.length > BUFFER_SIZE) b.lines.splice(0, b.lines.length - BUFFER_SIZE);
  for (const sub of b.subscribers) {
    try { sub(entry); } catch { /* subscriber broken, ignore */ }
  }
}
let seq = 0;

// Convenience helpers — same signature pattern.
export const linfo = (pid, msg, meta) => log(pid, 'info', msg, meta);
export const lok   = (pid, msg, meta) => log(pid, 'ok',   msg, meta);
export const lwarn = (pid, msg, meta) => log(pid, 'warn', msg, meta);
export const lerr  = (pid, msg, meta) => log(pid, 'error',msg, meta);
export const lcmd  = (pid, msg, meta) => log(pid, 'cmd',  msg, meta);

/** Return the current rolling buffer (for SSE catch-up on initial connect). */
export function recent(profileId) {
  return bus(profileId).lines.slice();
}

/** Subscribe to new entries. Returns an unsubscribe fn. */
export function subscribe(profileId, fn) {
  const b = bus(profileId);
  b.subscribers.add(fn);
  return () => b.subscribers.delete(fn);
}

/** Drop the in-memory buffer for a profile (e.g. when profile is deleted). */
export function clear(profileId) {
  buses.delete(profileId);
}
