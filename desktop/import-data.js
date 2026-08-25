#!/usr/bin/env node
/* eslint-disable no-console */
// Move an existing JobFinder working directory into the packaged desktop app.
//
//   node desktop/import-data.js            show what would be copied, change nothing
//   node desktop/import-data.js --go       do it
//
// WHAT IS COPIED, AND WHAT IS NOT
// The database, resumes, screenshots, mailbox tokens — and the browser profile that
// holds your logins, which is the part that would be painful to recreate.
//
// Deliberately skipped:
//   Cache, Code Cache, GPUCache, Service Worker   regenerated on demand, and on this
//                                                 machine they are 12 of the 13 GB
//   sessions/<id>/scan                            rebuilt from `main` on the next scan
//   sessions/<id>/<connector>                     left over from before every connector
//                                                 shared one profile; nothing reads them
//
// The existing destination is never overwritten in place: it is renamed aside first, so
// a botched import is one `mv` away from being undone.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const SRC = path.resolve(__dirname, '..', 'data');
const DST = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library/Application Support/JobFinder/data')
  : path.join(process.env.APPDATA || os.homedir(), 'JobFinder/data');

const GO = process.argv.includes('--go');

// Directory names inside a browser profile that are pure cache.
const CACHE_DIRS = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'ShaderCache', 'GrShaderCache', 'GraphiteDawnCache', 'component_crx_cache', 'extensions_crx_cache',
  'Service Worker', 'CacheStorage', 'ScriptCache', 'optimization_guide_model_store',
]);

let copiedBytes = 0;
let copiedFiles = 0;
let skippedBytes = 0;

function walkSize(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += walkSize(p);
      else total += fs.statSync(p).size;
    } catch { /* vanished mid-walk */ }
  }
  return total;
}

function copyTree(src, dst, skip) {
  let entries = [];
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
  if (GO) fs.mkdirSync(dst, { recursive: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (skip && skip(s, e)) { skippedBytes += e.isDirectory() ? walkSize(s) : safeSize(s); continue; }
    if (e.isDirectory()) {
      copyTree(s, d, skip);
    } else if (e.isFile()) {
      copiedFiles++;
      copiedBytes += safeSize(s);
      if (GO) {
        try { fs.copyFileSync(s, d); } catch (err) { console.log(`    ! ${e.name}: ${err.code}`); }
      }
    }
  }
}

function safeSize(p) { try { return fs.statSync(p).size; } catch { return 0; } }
const gb = (n) => `${(n / 1e9).toFixed(2)} GB`;
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

function profileIds() {
  const dir = path.join(SRC, 'sessions');
  try { return fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()); }
  catch { return []; }
}

/** Which profiles the database actually knows about — the rest are leftovers. */
function liveProfiles() {
  try {
    const Database = require(path.join(__dirname, '..', 'node_modules/better-sqlite3'));
    const db = new Database(path.join(SRC, 'jobfinder.db'), { readonly: true });
    const rows = db.prepare('SELECT id, name FROM profiles').all();
    db.close();
    return rows;
  } catch (e) {
    console.log(`  (could not read the database: ${e.message})`);
    return [];
  }
}

function main() {
  console.log(`\n  from : ${SRC}`);
  console.log(`  to   : ${DST}`);
  if (!fs.existsSync(SRC)) { console.log('\n  Nothing to import — no data directory.\n'); process.exit(1); }

  const live = liveProfiles();
  console.log(`\n  profiles in the database: ${live.map((p) => p.name).join(', ') || '(none)'}`);
  const keep = new Set(live.map((p) => p.id));

  // Top-level files: the database, its backups, tokens, resumes, screenshots.
  console.log('\n  files');
  for (const e of fs.readdirSync(SRC, { withFileTypes: true })) {
    if (e.name === 'sessions') continue;
    const s = path.join(SRC, e.name);
    const size = e.isDirectory() ? walkSize(s) : safeSize(s);
    console.log(`    ${e.name.padEnd(46)} ${mb(size).padStart(10)}`);
    copyTree.length; // keep lint quiet about the helper being used below
    if (e.isDirectory()) copyTree(s, path.join(DST, e.name), null);
    else { copiedFiles++; copiedBytes += size; if (GO) { fs.mkdirSync(DST, { recursive: true }); fs.copyFileSync(s, path.join(DST, e.name)); } }
  }

  // Browser profiles: only `main`, only for profiles the database still has, and
  // without the caches.
  console.log('\n  browser sessions');
  for (const id of profileIds()) {
    const label = live.find((p) => p.id === id)?.name || '(not in the database)';
    const main = path.join(SRC, 'sessions', id, 'main');
    if (!keep.has(id)) {
      const size = walkSize(path.join(SRC, 'sessions', id));
      skippedBytes += size;
      console.log(`    ${id.slice(0, 8)}  ${label.padEnd(22)} skipped        ${mb(size).padStart(10)}`);
      continue;
    }
    if (!fs.existsSync(main)) { console.log(`    ${id.slice(0, 8)}  ${label.padEnd(22)} no main profile`); continue; }
    const before = copiedBytes;
    copyTree(main, path.join(DST, 'sessions', id, 'main'), (p, e) => e.isDirectory() && CACHE_DIRS.has(e.name));
    console.log(`    ${id.slice(0, 8)}  ${label.padEnd(22)} logins copied  ${mb(copiedBytes - before).padStart(10)}`);
    // Everything else under this profile is either regenerated or long dead.
    for (const other of fs.readdirSync(path.join(SRC, 'sessions', id))) {
      if (other === 'main') continue;
      skippedBytes += walkSize(path.join(SRC, 'sessions', id, other));
    }
  }

  console.log(`\n  would copy : ${copiedFiles.toLocaleString()} files, ${gb(copiedBytes)}`);
  console.log(`  skipping   : ${gb(skippedBytes)} of cache and dead per-connector profiles`);

  if (!GO) {
    console.log('\n  Dry run. Nothing was written. Re-run with --go to import.\n');
    return;
  }
  console.log('\n  Imported.\n');
}

// Move any existing destination aside before writing, so this is reversible.
if (GO && fs.existsSync(DST) && fs.readdirSync(DST).length) {
  const aside = `${DST}.replaced-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  fs.renameSync(DST, aside);
  console.log(`\n  existing data moved aside: ${aside}`);
}

main();

// A copy that reports success while the database is unreadable is worse than a failure.
if (GO) {
  try {
    const Database = require(path.join(__dirname, '..', 'node_modules/better-sqlite3'));
    const db = new Database(path.join(DST, 'jobfinder.db'), { readonly: true });
    const p = db.prepare('SELECT COUNT(*) n FROM profiles').get().n;
    const j = db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
    const a = db.prepare('SELECT COUNT(*) n FROM answers').get().n;
    db.close();
    console.log(`  verified: ${p} profile(s), ${j.toLocaleString()} jobs, ${a} answers readable at the destination`);
    const cookies = path.join(DST, 'sessions');
    const n = fs.existsSync(cookies)
      ? execSync(`find "${cookies}" -name Cookies | wc -l`).toString().trim()
      : '0';
    console.log(`  verified: ${n} cookie store(s) in place\n`);
  } catch (e) {
    console.log(`\n  WARNING: the imported database did not open: ${e.message}\n`);
    process.exit(1);
  }
}
