// Local LLM client via Ollama. Mirrors the pattern from /Portfolio/src/llm/ollama_provider.py:
//   - /api/chat with messages array
//   - low-temperature deterministic options
//   - <think>…</think> stripped before returning
//   - keep_alive set so the model stays resident between calls (no cold reload every time)
//   - separate embed() that calls /api/embeddings with all-minilm for semantic retrieval.

// Pin IPv4 explicitly. Node 18+ fetch resolves "localhost" via DNS and on some
// macOS configs hits ::1 first, where Ollama (which binds to 127.0.0.1 by default)
// isn't listening — producing the cryptic "fetch failed" ECONNREFUSED.
const DEFAULT_URL = 'http://127.0.0.1:11434';
// CHAT MODEL — used by autofill to draft form answers.
//
// Was deepseek-r1:8b. That is a REASONING model, and autofill asks for short answers
// with num_predict: 80 — the entire budget goes into its <think> block before a single
// useful token, so the reply came back EMPTY. Measured on four ordinary fields (notice
// period, years of experience, work authorisation, expected CTC):
//
//   deepseek-r1:8b        19.3s   all four EMPTY
//   qwen2.5:7b-instruct    2.9s   all four correct
//   qwen2.5:3b-instruct    3.1s   two wrong - invented a salary figure
//
// So this was not merely slow: every LLM-drafted short field was silently failing. The
// 3B was no faster once warm and materially less accurate, which is the wrong trade for
// text that goes into a real application.
//
// Using the same model for chat and synthesis also means ONE model resident rather than
// two. On a 16GB Mac that matters: deepseek (5.2GB) plus qwen (4.7GB) pinned for 30
// minutes alongside Chrome is what produced an Ollama stall earlier in this project.
const DEFAULT_MODEL = 'qwen2.5:7b-instruct';
// Embeddings for the answer bank.
//
// NOT nomic-embed-text, which this project used until it was actually measured against
// real form questions. nomic produces a vector dominated by one huge component (~-3.7
// where every other dimension is ~0.1), and that component barely moves with the text.
// Cosine then measures almost nothing: on this bank it scored 'Expected CTC' against
// 'City / Berlin' at 1.000 — a perfect match between unrelated fields — and got 1 of 8
// known-answerable questions right. That is what filled "India" into Expected CTC.
//
// Measured on the same 17 questions against a real 35-row bank:
//     nomic-embed-text    1/8 correct   true 0.58-0.62 vs false 0.60-1.00  (overlapping)
//     mxbai-embed-large   6/10 correct  true 0.65+     vs false up to 0.67 (overlapping)
//     all-minilm          8/10 correct  true 0.35-0.90 vs false up to 0.46 (separated)
//
// all-minilm also happens to be the smallest of the three (46MB) and the fastest.
// Its scores run lower in absolute terms, which is why SIM_THRESHOLD in knowledge.js
// is tuned to it — do not change one without re-measuring the other.
const EMBED_MODEL = 'all-minilm';
// Keep the model pinned in VRAM/RAM for 30 minutes between calls so autofills are instant.
const KEEP_ALIVE = '30m';

// Every call needs a deadline.
//
// Without one, a request that Ollama accepts but never generates for hangs forever, and
// anything waiting on it hangs with it. Observed during a prep build: two connections
// open to :11434, the model loaded, and the runner sitting at 3.7% CPU — not generating,
// not erroring. The build had been "stuck" for a long time with no way to recover short
// of restarting the app.
const DEFAULT_TIMEOUT_MS = Number(process.env.JOBFINDER_LLM_TIMEOUT_MS || 240000);

// Retry helper — retries on transient network errors (ECONNREFUSED, ECONNRESET, etc.)
async function fetchWithRetry(url, options, retries = 3, timeoutMs = DEFAULT_TIMEOUT_MS) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const msg = String(err?.message || err);
      // A timeout is NOT transient in the retry sense — the model is wedged, and
      // hammering it again just burns another few minutes. Surface it instead.
      if (err?.name === 'TimeoutError' || /aborted|timed? ?out/i.test(msg)) {
        throw new Error(
          `Ollama did not respond within ${Math.round(timeoutMs / 1000)}s — the model is wedged or the ` +
          `request is too large. Try a smaller num_predict, or restart with: brew services restart ollama`
        );
      }
      const transient = /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|fetch failed|network/i.test(msg);
      if (!transient || attempt === retries) throw err;
      // Exponential backoff: 1s, 2s, 4s
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }
}

import { parseFilters } from './profileSettings.js';

// Preferred models for bulk JSON synthesis (interview prep), best first.
//
// These are INSTRUCT models, not reasoning models. deepseek-r1 emits a <think> block
// before any output, so most of num_predict is spent before the first useful token —
// measured here: a budget of 2400 produced a 0-character reply, and 8-10 minutes per
// skill. An instruct model of the same size answers in a fraction of that and holds
// together on longer JSON, which is what caps question count.
const SYNTH_PREFERENCES = [
  'qwen2.5:7b-instruct',
  'qwen2.5:14b-instruct',
  'llama3.1:8b-instruct-q4_K_M',
  'llama3.1:8b',
  'mistral:7b-instruct',
];

let _installed = null;      // Set<string> of model names, cached
let _installedAt = 0;
const INSTALLED_TTL = 60000;

async function installedModels(url) {
  if (_installed && Date.now() - _installedAt < INSTALLED_TTL) return _installed;
  try {
    const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    _installed = new Set((j.models || []).map((m) => m.name));
    _installedAt = Date.now();
  } catch { _installed = _installed || new Set(); }
  return _installed;
}

/**
 * Which model should synthesis use? An explicit profile setting always wins; otherwise
 * pick the best installed instruct model, and only fall back to the chat model if none
 * is present. This means installing one is all it takes to speed prep up.
 */
/**
 * Which model should ordinary chat (autofill drafting) use?
 *
 * Same shape as resolveSynthModel: an explicit per-profile setting wins, otherwise the
 * best installed instruct model, otherwise whatever DEFAULT_MODEL names. Without this a
 * fresh machine that has some other instruct model would fall back to a tag it does not
 * have and fail on the first autofill.
 */
export async function resolveChatModel(profile) {
  const cfg = profileLLM(profile);
  const filters = parseFilters(profile);
  if (filters.llm_model) return filters.llm_model;
  const have = await installedModels(cfg.url);
  if (have.has(DEFAULT_MODEL) || have.has(`${DEFAULT_MODEL}:latest`)) return DEFAULT_MODEL;
  for (const m of SYNTH_PREFERENCES) {
    if (have.has(m) || have.has(`${m}:latest`)) return m;
  }
  return cfg.model;
}

export async function resolveSynthModel(profile) {
  const cfg = profileLLM(profile);
  const filters = parseFilters(profile);
  if (filters.synth_model) return filters.synth_model;      // explicit choice
  const have = await installedModels(cfg.url);
  for (const m of SYNTH_PREFERENCES) {
    if (have.has(m) || have.has(`${m}:latest`)) return m;
  }
  return cfg.synth_model;
}

function profileLLM(profile) {
  const filters = parseFilters(profile);
  return {
    url: (filters.llm_url || DEFAULT_URL).replace(/\/$/, ''),
    model: filters.llm_model || DEFAULT_MODEL,
    embed_model: filters.embed_model || EMBED_MODEL,
    // Optional separate model for bulk generation (interview-prep synthesis).
    // Reasoning models like deepseek-r1 spend most of their token budget inside
    // <think> blocks, which makes long-form generation 3-5x slower than an
    // equivalent non-reasoning model. Falls back to the main chat model.
    synth_model: filters.synth_model || filters.llm_model || DEFAULT_MODEL,
  };
}

/** Which model bulk synthesis will use — surfaced in the prep UI. */
export function synthesisModel(profile) {
  return profileLLM(profile).synth_model;
}

// Same regex used in the Portfolio project — handles multiple thinking blocks, case-insensitive.
const THINK_RE = /<think>[\s\S]*?<\/think>/gi;
const OPEN_THINK_RE = /<think>[\s\S]*$/i;

export function stripThinking(text) {
  if (!text) return '';
  let out = text.replace(THINK_RE, '');
  // If the model ran out of tokens mid-think, drop the unterminated tail.
  out = out.replace(OPEN_THINK_RE, '');
  return out.trim();
}

/**
 * @param json  when true, ask Ollama to constrain decoding to valid JSON
 *              (format:"json"). Essential with reasoning models like deepseek-r1,
 *              which otherwise wrap their answer in prose and break JSON.parse.
 */
export async function chat(profile, messages, { num_predict = 800, temperature = 0.3, keep_alive = KEEP_ALIVE, json = false, useSynthModel = false, timeoutMs } = {}) {
  const cfg = profileLLM(profile);
  const { url } = cfg;
  const model = useSynthModel ? await resolveSynthModel(profile) : await resolveChatModel(profile);
  let res;
  try {
    const body = {
      model,
      messages,
      stream: false,
      keep_alive,
      options: { temperature, num_predict, num_ctx: 8192 },
    };
    if (json) body.format = 'json';
    res = await fetchWithRetry(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, 3, timeoutMs);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/ECONNREFUSED/i.test(msg)) {
      throw new Error('Ollama is not running. Start it with: ollama serve');
    }
    throw err;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const rawContent = data?.message?.content || '';
  const out = stripThinking(rawContent);

  // Reasoning models (deepseek-r1 et al.) always emit a <think> block first. If
  // num_predict is too small, the ENTIRE budget goes to thinking, stripThinking()
  // removes all of it, and we silently return "". That failure mode is invisible at
  // the call site and produced hard-to-trace bugs (e.g. skill extraction returning
  // zero results). Surface it loudly instead.
  if (!out && rawContent) {
    const reason = data?.done_reason ? ` (done_reason=${data.done_reason})` : '';
    console.warn(
      `[llm] Response was entirely reasoning tokens — nothing left after stripping <think>${reason}. ` +
      `num_predict=${num_predict} is too small for this model. Raise it or use a non-reasoning model.`
    );
  }
  return out;
}

// Backwards-compatible facade
export async function generate(profile, { system, prompt, num_predict = 800 }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  return await chat(profile, messages, { num_predict });
}

export async function embed(profile, text) {
  const { url, embed_model } = profileLLM(profile);
  const res = await fetchWithRetry(`${url}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: embed_model, prompt: String(text || '').slice(0, 8000), keep_alive: KEEP_ALIVE }),
  });
  if (!res.ok) throw new Error(`Ollama embed ${res.status}`);
  const data = await res.json();
  return data.embedding || null;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Preload the chat model so the first real request is fast.
// Equivalent to Ollama's `ollama run <model>` then idle — we POST an empty prompt with keep_alive.
export async function preload(url = DEFAULT_URL, model = DEFAULT_MODEL, embedModel = EMBED_MODEL) {
  const base = url.replace(/\/$/, '');
  const result = { chat: false, embed: false, model, embedModel, url: base };
  try {
    const r = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: KEEP_ALIVE }),
    });
    result.chat = r.ok;
  } catch (e) { result.chatError = String(e?.message || e); }
  try {
    const r = await fetch(`${base}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: embedModel, prompt: 'warmup', keep_alive: KEEP_ALIVE }),
    });
    result.embed = r.ok;
  } catch (e) { result.embedError = String(e?.message || e); }
  return result;
}

export async function llmHealth(profile) {
  const { url, model, embed_model } = profileLLM(profile);
  try {
    const r = await fetch(`${url}/api/tags`);
    if (!r.ok) return { ok: false, url, model, error: `HTTP ${r.status}` };
    const data = await r.json();
    const names = (data.models || []).map((m) => m.name);
    const matchesModel = (installed, wanted) => {
      // Exact match
      if (installed === wanted) return true;
      // Strip tag from both and compare base names
      const base = (s) => s.split(':')[0];
      if (base(installed) === base(wanted)) return true;
      // Handle 'deepseek-r1:8b' matching 'deepseek-r1:8b-q4_0'
      if (installed.startsWith(wanted) || wanted.startsWith(installed)) return true;
      return false;
    };
    return {
      ok: true, url, model, embed_model,
      modelInstalled: names.some((n) => matchesModel(n, model)),
      embedInstalled: names.some((n) => matchesModel(n, embed_model)),
      models: names,
    };
  } catch (e) {
    return { ok: false, url, model, error: String(e?.message || e) };
  }
}

export function writeupSystemPrompt(profile, job, knowledge = []) {
  const bio = parseFilters(profile).bio || '';

  const kbLines = knowledge.length
    ? '\nKNOWN ANSWERS THE CANDIDATE HAS GIVEN BEFORE (use these as the source of truth — paraphrase/adapt to the new question, do NOT contradict):\n' +
      knowledge.map((k, i) => `  [${i + 1}] (${k.label || k.field_key}) → ${k.value}`).join('\n')
    : '';

  return [
    'You are filling out a job application form on behalf of the candidate.',
    'Write in first person, professional but warm, concise (3-6 sentences unless the question explicitly asks for more).',
    'Do NOT invent specific facts (employers, exact years, degrees, salary) that are not present in the candidate data below.',
    'If asked for a specific value the candidate has already given (years of experience, notice period, salary, work auth, etc.), use that exact value.',
    'Output ONLY the answer text. No preamble, no markdown headers, no "Sure, here is".',
    '',
    `CANDIDATE NAME: ${profile.name || ''}`,
    `EMAIL: ${profile.email || ''}`,
    `TARGET ROLES / KEYWORDS: ${profile.keywords || ''}`,
    `LOCATIONS: ${profile.locations || ''}`,
    bio ? `BIO / SUMMARY:\n${bio}` : '',
    kbLines,
    '',
    `JOB CONTEXT: ${job?.title || ''} at ${job?.company || ''} (${job?.location || ''})`,
    job?.description ? `JOB DESCRIPTION:\n${(job.description || '').slice(0, 2000)}` : '',
  ].filter(Boolean).join('\n');
}

export async function pullModel(profile, modelName) {
  const { url } = profileLLM(profile);
  const res = await fetch(`${url}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: modelName, stream: false }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Pull failed ${res.status}: ${txt.slice(0, 200)}`);
  }
  return await res.json();
}

export const LLM_DEFAULTS = { DEFAULT_URL, DEFAULT_MODEL, EMBED_MODEL };
