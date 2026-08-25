// First-run setup: everything the app needs that is not inside the package.
//
// The person receiving this has not read a README and should not have to. So the app
// installs what it needs, says what it is doing while it does it, and never fails
// silently — a spinner that stops with no explanation is the worst outcome here,
// because there is nothing for them to debug.
//
// Two things are fetched: Ollama (the local model runtime) and the two models. Chromium
// ships inside the package, so nothing is downloaded for the browser.
//
// Every step is idempotent. Re-running after a half-finished install picks up where it
// stopped rather than starting again — model pulls are the slow part and Ollama itself
// skips layers it already has.

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const CHAT_MODEL = 'qwen2.5:7b-instruct';
const EMBED_MODEL = 'all-minilm';
const OLLAMA_HOST = 'http://127.0.0.1:11434';

/** Where Ollama lives once installed, per platform. Checked before anything is fetched. */
function ollamaCandidates() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Ollama.app/Contents/Resources/ollama',
      '/usr/local/bin/ollama',
      '/opt/homebrew/bin/ollama',
      path.join(os.homedir(), '.ollama/bin/ollama'),
    ];
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    return [
      path.join(local, 'Programs/Ollama/ollama.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Ollama/ollama.exe'),
    ];
  }
  return ['/usr/local/bin/ollama', '/usr/bin/ollama'];
}

function findOllama() {
  for (const p of ollamaCandidates()) {
    try { if (fs.existsSync(p)) return p; } catch { /* unreadable path */ }
  }
  return null;
}

/** Is the Ollama server answering? That is the only test that actually matters. */
function ollamaUp(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = require('node:http').get(`${OLLAMA_HOST}/api/tags`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

function listModels() {
  return new Promise((resolve) => {
    const req = require('node:http').get(`${OLLAMA_HOST}/api/tags`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve((JSON.parse(body).models || []).map((m) => m.name)); }
        catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(4000, () => { req.destroy(); resolve([]); });
  });
}

function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u, redirects = 0) => {
      https.get(u, { headers: { 'user-agent': 'JobFinder-Setup' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          if (redirects > 5) return reject(new Error('too many redirects'));
          res.resume();
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const total = Number(res.headers['content-length']) || 0;
        let seen = 0;
        res.on('data', (c) => {
          seen += c.length;
          if (total && onProgress) onProgress(seen / total);
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      }).on('error', reject);
    };
    get(url);
  });
}

/**
 * Install Ollama.
 *
 * Deliberately NOT silent on either platform. On macOS the download is a .zip holding
 * Ollama.app, which is moved into /Applications — that needs no admin rights as long as
 * the user owns /Applications, which is the normal case. On Windows the official
 * installer is run with /VERYSILENT, and that DOES raise a UAC prompt; the caller warns
 * about it first, because an unexplained admin prompt is how software gets closed.
 */
async function installOllama(log) {
  const tmp = path.join(os.tmpdir(), `jobfinder-ollama-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });

  if (process.platform === 'darwin') {
    const zip = path.join(tmp, 'Ollama.zip');
    log('Downloading Ollama…');
    await download('https://ollama.com/download/Ollama-darwin.zip', zip, (p) =>
      log(`Downloading Ollama… ${Math.round(p * 100)}%`));
    log('Installing Ollama…');
    await run('/usr/bin/ditto', ['-x', '-k', zip, '/Applications']);
    return findOllama();
  }

  if (process.platform === 'win32') {
    const exe = path.join(tmp, 'OllamaSetup.exe');
    log('Downloading Ollama…');
    await download('https://ollama.com/download/OllamaSetup.exe', exe, (p) =>
      log(`Downloading Ollama… ${Math.round(p * 100)}%`));
    log('Installing Ollama — approve the Windows prompt if it appears…');
    await run(exe, ['/VERYSILENT', '/NORESTART']).catch(() => {});
    // The installer returns before the files settle; give it a moment to appear.
    for (let i = 0; i < 20 && !findOllama(); i++) await wait(1000);
    return findOllama();
  }

  throw new Error(`Unsupported platform ${process.platform}`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 24, ...opts }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start the Ollama server and wait for it to answer. */
async function startOllama(bin, log) {
  if (await ollamaUp()) return true;
  log('Starting the local model runtime…');
  if (process.platform === 'darwin' && fs.existsSync('/Applications/Ollama.app')) {
    // Launching the .app also installs the CLI and the login item, which is what a
    // person who later opens Ollama themselves would expect to find.
    spawn('/usr/bin/open', ['-a', '/Applications/Ollama.app'], { detached: true, stdio: 'ignore' }).unref();
  } else if (bin) {
    spawn(bin, ['serve'], { detached: true, stdio: 'ignore' }).unref();
  }
  for (let i = 0; i < 45; i++) {
    if (await ollamaUp()) return true;
    await wait(1000);
  }
  return false;
}

/**
 * Pull a model, reporting progress.
 *
 * Uses the HTTP API rather than the CLI because it streams machine-readable progress —
 * a 4.7 GB download with no visible movement is indistinguishable from a hang, and this
 * is the step where someone decides the app is broken and quits.
 */
function pullModel(name, log) {
  return new Promise((resolve, reject) => {
    const req = require('node:http').request(`${OLLAMA_HOST}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const j = JSON.parse(line);
            if (j.error) return reject(new Error(j.error));
            if (j.total && j.completed) {
              const pct = Math.round((j.completed / j.total) * 100);
              const gb = (j.total / 1e9).toFixed(1);
              log(`Downloading ${name} — ${pct}% of ${gb} GB`);
            } else if (j.status) {
              log(`${name}: ${j.status}`);
            }
          } catch { /* partial line */ }
        }
      });
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.write(JSON.stringify({ name, stream: true }));
    req.end();
  });
}

/**
 * Get the machine ready. Returns a short status the caller can show.
 *
 * Never throws: a missing model means the assistant features are degraded, not that the
 * app is unusable — scanning, applying and the answer bank all work without it. Saying
 * so beats refusing to start.
 */
async function ensureRuntime(log) {
  const result = { ollama: false, chat: false, embed: false, note: '' };
  try {
    let bin = findOllama();
    if (!bin && !(await ollamaUp())) {
      log('Setting up the local AI runtime (one time, about 5 minutes)…');
      bin = await installOllama(log);
    }
    result.ollama = await startOllama(bin, log);
    if (!result.ollama) {
      result.note = 'The local AI runtime did not start. Everything except drafted answers still works.';
      return result;
    }

    const have = await listModels();
    const has = (m) => have.some((x) => x === m || x.startsWith(`${m.split(':')[0]}:`));

    if (!has(EMBED_MODEL)) {
      log('Downloading the matching model (46 MB)…');
      await pullModel(EMBED_MODEL, log);
    }
    result.embed = true;

    if (!has(CHAT_MODEL)) {
      log('Downloading the writing model (4.7 GB) — this is the long one, once only…');
      await pullModel(CHAT_MODEL, log);
    }
    result.chat = true;
    return result;
  } catch (e) {
    result.note = `Setup could not finish: ${String(e?.message || e).slice(0, 160)}`;
    return result;
  }
}

module.exports = { ensureRuntime, ollamaUp, CHAT_MODEL, EMBED_MODEL };
