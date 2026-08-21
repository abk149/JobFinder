import { get } from '../../../../lib/db.js';
import { parseFilters } from '../../../../lib/profileSettings.js';
import { readJson, requireFields, withErrorHandling } from '../../../../lib/http.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 600; // model pulls can take a while

export const POST = withErrorHandling(async (req) => {
  const { profile_id, model } = await readJson(req);
  requireFields({ model }, ['model']);

  const profile = profile_id ? await get('SELECT * FROM profiles WHERE id = ?', [profile_id]) : null;
  // Pin IPv4: Node fetch resolves "localhost" to ::1 on some macOS setups where
  // Ollama only binds 127.0.0.1, producing a confusing "fetch failed".
  const filters = parseFilters(profile);
  const url = (filters.llm_url || 'http://127.0.0.1:11434').replace(/\/$/, '');

  try {
    const res = await fetch(`${url}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: model, stream: false }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return Response.json({ error: `Pull failed: ${txt.slice(0, 300)}` }, { status: 502 });
    }
    const data = await res.json();
    return Response.json({ ok: true, status: data.status || 'success' });
  } catch (e) {
    return Response.json({ error: `Ollama unreachable: ${e?.message || e}. Run: ollama serve` }, { status: 502 });
  }
});
