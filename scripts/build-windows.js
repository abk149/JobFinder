#!/usr/bin/env node
/* eslint-disable no-console */
// Build a Windows-ready distribution of JobFinder.
//
// What this produces under `dist/windows/`:
//   app/                     Next.js standalone build (server.js + .next/ + node_modules subset)
//   app/public/              static assets
//   app/.next/static/        static chunks
//   node/node.exe            Windows x64 Node.js runtime
//   scripts/                 launcher .bat + PowerShell helpers
//   README.txt               shipped docs
//
// After this script finishes, hand `dist/windows/` to Inno Setup with the .iss file
// in installer/jobfinder.iss to produce the final JobFinder-Setup-<ver>.exe.
//
// Runs on macOS / Linux (cross-platform build). Doesn't require a Windows machine.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'windows');
const APP = path.join(DIST, 'app');
const NODE_DIR = path.join(DIST, 'node');
const NODE_VERSION = process.env.JOBFINDER_NODE_VERSION || 'v20.18.0'; // LTS, ABI 115
const NODE_ABI = '115';

// --- helpers ---------------------------------------------------------------

function step(label) { console.log(`\n▶ ${label}`); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function cprf(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dst, { recursive: true, force: true, errorOnExist: false });
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    mkdirp(path.dirname(destPath));
    const file = fs.createWriteStream(destPath);
    function get(u, redirects = 0) {
      https.get(u, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          if (redirects > 5) return reject(new Error(`Too many redirects: ${u}`));
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${u}`));
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let got = 0; let lastPct = -1;
        res.on('data', (chunk) => {
          got += chunk.length;
          if (total) {
            const pct = Math.floor((got / total) * 100);
            if (pct !== lastPct && pct % 10 === 0) {
              lastPct = pct;
              process.stdout.write(`  ${pct}% (${(got / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB)\r`);
            }
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', reject);
    }
    get(url);
  });
}

function sizeMb(p) {
  let total = 0;
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, f.name);
      if (f.isDirectory()) walk(fp);
      else try { total += fs.statSync(fp).size; } catch { /* ignore */ }
    }
  };
  walk(p);
  return (total / 1e6).toFixed(1);
}

// --- main ------------------------------------------------------------------

async function main() {
  // 1. clean
  step('Cleaning previous build');
  rmrf(DIST);
  mkdirp(DIST);

  // 2. run next build (with data/ temporarily moved aside)
  //
  // CRITICAL: Next's file tracer otherwise drags `data/` (live SQLite DB plus the
  // logged-in Chrome sessions — cookies, cache, history, ~12 GB) into the standalone
  // output. We move it aside for the duration of the build, then restore it.
  step('Running next build (standalone)');
  const dataDir = path.join(ROOT, 'data');
  const dataBackup = path.join(ROOT, '.data-build-backup');
  let dataMoved = false;
  if (fs.existsSync(dataDir)) {
    rmrf(dataBackup);
    fs.renameSync(dataDir, dataBackup);
    dataMoved = true;
    console.log('  Moved data/ aside so Next tracer doesn\'t suck it into the build');
  }
  try {
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production', JOBFINDER_STANDALONE: '1' } });
  } finally {
    if (dataMoved) {
      rmrf(dataDir);
      fs.renameSync(dataBackup, dataDir);
      console.log('  Restored data/');
    }
  }

  // 3. lay out the standalone app
  step('Assembling app/ from .next/standalone');
  mkdirp(APP);
  const standaloneDir = path.join(ROOT, '.next', 'standalone');
  if (!fs.existsSync(standaloneDir)) {
    throw new Error(`Expected ${standaloneDir} to exist. Did next build succeed?`);
  }
  cprf(standaloneDir, APP);
  // Next standalone doesn't auto-copy public/ or .next/static/ — we do it.
  cprf(path.join(ROOT, 'public'), path.join(APP, 'public'));
  cprf(path.join(ROOT, '.next', 'static'), path.join(APP, '.next', 'static'));
  // Connectors are imported dynamically — copy them verbatim.
  cprf(path.join(ROOT, 'connectors'), path.join(APP, 'connectors'));

  // 4. swap better-sqlite3 native binary darwin → win32-x64
  //
  // On macOS the installed better-sqlite3 has ONLY the darwin binary. Shipping that
  // to Windows would crash on first require. We download the matching win32-x64
  // prebuild (Node 20 = ABI 115) from the better-sqlite3 GitHub releases and replace
  // build/Release/better_sqlite3.node so the bindings loader finds the right one.
  step('Installing Windows-x64 better-sqlite3 binary');
  const bsqlitePkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'node_modules', 'better-sqlite3', 'package.json'), 'utf8')
  );
  const bsqliteUrl =
    `https://github.com/WiseLibs/better-sqlite3/releases/download/v${bsqlitePkg.version}` +
    `/better-sqlite3-v${bsqlitePkg.version}-node-v${NODE_ABI}-win32-x64.tar.gz`;
  const bsqliteTgz = path.join(DIST, 'bsqlite-win32-x64.tar.gz');
  const bsqliteAppDir = path.join(APP, 'node_modules', 'better-sqlite3');
  if (!fs.existsSync(bsqliteAppDir)) {
    throw new Error(`Expected better-sqlite3 to be present in standalone at ${bsqliteAppDir}`);
  }
  // Wipe the macOS binary first — the tarball would overwrite it but we want to be
  // sure we're not accidentally shipping a darwin .node that confuses the loader.
  const bsqliteRelease = path.join(bsqliteAppDir, 'build', 'Release');
  mkdirp(bsqliteRelease);
  for (const f of fs.readdirSync(bsqliteRelease)) fs.unlinkSync(path.join(bsqliteRelease, f));

  await download(bsqliteUrl, bsqliteTgz);
  console.log(`  ✓ Downloaded better-sqlite3 v${bsqlitePkg.version} for win32-x64 (Node ABI ${NODE_ABI})`);
  execSync(`tar -xzf "${bsqliteTgz}" -C "${bsqliteAppDir}"`, { stdio: 'inherit' });
  fs.unlinkSync(bsqliteTgz);
  const winBin = path.join(bsqliteRelease, 'better_sqlite3.node');
  if (!fs.existsSync(winBin)) {
    throw new Error(`better-sqlite3 native binary missing after extract: ${winBin}`);
  }
  console.log(`  ✓ build/Release/better_sqlite3.node installed (${(fs.statSync(winBin).size / 1024).toFixed(0)} KB)`);

  // 5. download Windows Node.js binary
  step(`Downloading Node.js ${NODE_VERSION} for Windows x64`);
  const nodeZipName = `node-${NODE_VERSION}-win-x64.zip`;
  const nodeZip = path.join(DIST, nodeZipName);
  await download(`https://nodejs.org/dist/${NODE_VERSION}/${nodeZipName}`, nodeZip);
  console.log(`  ✓ Downloaded ${nodeZipName}`);

  step('Extracting Node.js');
  mkdirp(NODE_DIR);
  try {
    execSync(`unzip -q -o "${nodeZip}" -d "${DIST}"`, { stdio: 'inherit' });
  } catch (e) {
    throw new Error('unzip not installed. brew install unzip (or extract manually).');
  }
  const extracted = path.join(DIST, `node-${NODE_VERSION}-win-x64`);
  fs.renameSync(path.join(extracted, 'node.exe'), path.join(NODE_DIR, 'node.exe'));
  rmrf(extracted);
  fs.unlinkSync(nodeZip);
  console.log('  ✓ node.exe in dist/windows/node/');

  // 6. installer assets
  step('Copying installer assets');
  mkdirp(path.join(DIST, 'scripts'));
  cprf(path.join(ROOT, 'installer', 'launcher.bat'), path.join(DIST, 'scripts', 'launcher.bat'));
  cprf(path.join(ROOT, 'installer', 'post-install-models.ps1'), path.join(DIST, 'scripts', 'post-install-models.ps1'));
  cprf(path.join(ROOT, 'installer', 'README.txt'), path.join(DIST, 'README.txt'));

  // 7. summary
  step('Build complete');
  console.log(`\n  📦 dist/windows/  →  ${sizeMb(DIST)} MB`);
  console.log('\nNext step: run Inno Setup on installer/jobfinder.iss to produce JobFinder-Setup.exe');
  console.log('  (On Windows: ISCC.exe installer\\jobfinder.iss)');
  console.log('  (Cross-platform: install innosetup via Wine, or run ISCC on a Windows machine)');
}

main().catch((e) => {
  console.error('\n✗ Build failed:', e.message);
  process.exit(1);
});
