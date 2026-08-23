// Next.js startup hook. Runs once when the server boots — both `next dev` and `next start`.
// Used to warm Ollama so the first autofill / writeup is fast (model already resident).

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { preload, LLM_DEFAULTS } = await import('./lib/llm.js');
  const url = process.env.OLLAMA_URL || LLM_DEFAULTS.DEFAULT_URL;
  const model = process.env.OLLAMA_MODEL || LLM_DEFAULTS.DEFAULT_MODEL;
  const embedModel = process.env.OLLAMA_EMBED_MODEL || LLM_DEFAULTS.EMBED_MODEL;

  // Report the synthesis model too — it is chosen automatically from what's installed,
  // so without this line there is no way to tell which model prep and cover letters
  // actually used.
  //
  // Deliberately NOT preloaded. This machine has 16 GB; deepseek-r1:8b (5.2 GB) and
  // qwen2.5:7b-instruct (4.7 GB) both pinned for keep_alive=30m, alongside Chrome, is
  // ~10 GB of models on a box that had 3.2 GB free — which is what an Ollama stall
  // looks like from the outside (model resident, runner at 3.7% CPU, generating
  // nothing). It loads on first use instead; that costs a few seconds once.
  // Chat and synthesis now resolve to the same instruct model, so the warmup pins one
  // model rather than two — which is what keeps a 16GB machine off the swap.
  let synth = '(auto)';
  try {
    const { resolveSynthModel } = await import('./lib/llm.js');
    synth = await resolveSynthModel({ filters: '{}' });
  } catch { /* non-fatal */ }

  console.log(`[JobFinder] Preloading Ollama models: chat=${model}, embed=${embedModel} @ ${url}`);
  console.log(`[JobFinder] Prep/cover-letter synthesis will use: ${synth} (loaded on first use)`);

  const MAX_RETRIES = 3;
  const RETRY_DELAY = 3000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await preload(url, model, embedModel);
      const parts = [];
      parts.push(r.chat ? `✅ chat (${r.model})` : `❌ chat: ${r.chatError || 'failed'}`);
      parts.push(r.embed ? `✅ embed (${r.embedModel})` : `❌ embed: ${r.embedError || 'failed'}`);
      console.log(`[JobFinder] LLM warmup: ${parts.join(' · ')}`);
      if (r.chat || r.embed) break; // At least one model loaded
      if (attempt < MAX_RETRIES) {
        console.log(`[JobFinder] LLM warmup: no models loaded, retrying in ${RETRY_DELAY / 1000}s (attempt ${attempt}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    } catch (e) {
      console.log(`[JobFinder] LLM warmup error (attempt ${attempt}/${MAX_RETRIES}): ${e?.message || e}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        console.log('[JobFinder] LLM warmup failed after all retries. Ollama may not be running — start it with: ollama serve');
      }
    }
  }
}
