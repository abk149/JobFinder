// Resume saved auto-apply schedules, once per server process.
//
// This lives behind a route handler rather than in instrumentation.js on purpose. The
// scheduler reaches the database and the browser stack, and importing that chain from
// instrumentation made Next try to bundle better-sqlite3's native loader for a
// non-Node target — the build failed on "Can't resolve 'fs'", then on 'path' inside
// file-uri-to-path. Route handlers already bundle this code correctly, so the schedule
// is resumed by the first request that touches the app, which the dashboard makes on
// load anyway.

import { startAll } from './scheduler.js';

let booted = false;

export function ensureSchedulerStarted() {
  if (booted) return;
  booted = true;
  startAll()
    .then((n) => { if (!n) console.log('[JobFinder] ⏰ No auto-apply schedules are active.'); })
    .catch((e) => console.warn('[JobFinder] auto-apply scheduler did not start:', e?.message || e));
}
