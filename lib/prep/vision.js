// Image → text extraction via a local Ollama vision model.
//
// qwen2.5:7b-instruct is TEXT-ONLY — it cannot read images. So image extraction is an
// optional capability: we probe Ollama for an installed vision-capable model and
// use it if present. If none is installed we degrade gracefully and tell the caller
// exactly what to pull, rather than silently producing nothing.
//
// Used by the prep collector to pull text out of screenshots people post (interview
// question screenshots, whiteboard photos, system-design diagrams, salary tables).

import { parseFilters } from '../profileSettings.js';

const DEFAULT_URL = 'http://127.0.0.1:11434';

// Ordered by preference: quality first, then size. Matched as a prefix against the
// installed model names so tags (":7b", ":latest") don't matter.
const VISION_MODELS = [
  'llama3.2-vision',
  'qwen2.5vl',
  'qwen2-vl',
  'minicpm-v',
  'llava-llama3',
  'llava',
  'bakllava',
  'granite3.2-vision',
  'moondream',
];

function baseUrl(profile) {
  const f = parseFilters(profile);
  return (f.llm_url || DEFAULT_URL).replace(/\/$/, '');
}

/**
 * Detect whether any vision-capable model is installed.
 * Returns { available, model, installed[], suggestion }.
 */
export async function visionCapability(profile) {
  const url = baseUrl(profile);
  try {
    const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { available: false, model: null, installed: [], error: `Ollama HTTP ${r.status}` };
    const data = await r.json();
    const installed = (data.models || []).map((m) => m.name);
    for (const want of VISION_MODELS) {
      const hit = installed.find((n) => n.toLowerCase().startsWith(want));
      if (hit) return { available: true, model: hit, installed };
    }
    return {
      available: false,
      model: null,
      installed,
      suggestion: 'moondream',
      hint: 'No vision model installed. Pull a small one with:  ollama pull moondream   (~1.7 GB) — or llama3.2-vision (~7.9 GB) for better quality.',
    };
  } catch (e) {
    return { available: false, model: null, installed: [], error: String(e?.message || e) };
  }
}

/**
 * Extract text / a description from an image.
 *
 * @param profile  the profile row (for llm_url override)
 * @param imageB64 base64-encoded image data WITHOUT the data: prefix
 * @param prompt   what to ask about the image
 * @returns { ok, text, model } or { ok:false, reason }
 */
export async function describeImage(profile, imageB64, prompt) {
  const cap = await visionCapability(profile);
  if (!cap.available) {
    return { ok: false, reason: cap.hint || cap.error || 'No vision model available', capability: cap };
  }
  const url = baseUrl(profile);
  try {
    const r = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cap.model,
        prompt:
          prompt ||
          'Transcribe ALL text visible in this image verbatim. Then, in one sentence, say what the image shows. If it contains an interview question, coding problem, or diagram, describe it precisely.',
        images: [imageB64],
        stream: false,
        keep_alive: '10m',
        options: { temperature: 0.1, num_predict: 700 },
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) return { ok: false, reason: `Ollama ${r.status}` };
    const data = await r.json();
    return { ok: true, text: (data.response || '').trim(), model: cap.model };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

/** Fetch a remote image and run it through describeImage. Returns null on any failure. */
export async function describeImageUrl(profile, imageUrl, prompt) {
  try {
    const r = await fetch(imageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return null;
    const type = r.headers.get('content-type') || '';
    if (!/^image\//.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    // Skip anything implausibly large — vision models choke and it's rarely useful.
    if (buf.length > 6 * 1024 * 1024) return null;
    const out = await describeImage(profile, buf.toString('base64'), prompt);
    return out.ok ? out.text : null;
  } catch {
    return null;
  }
}
