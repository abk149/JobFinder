import { get } from '../../../lib/db.js';
import { chat, llmHealth, writeupSystemPrompt } from '../../../lib/llm.js';
import { retrieve, backfillEmbeddings } from '../../../lib/knowledge.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const profile_id = searchParams.get('profile_id');
  const profile = profile_id ? await get('SELECT * FROM profiles WHERE id = ?', [profile_id]) : null;
  const health = await llmHealth(profile);
  return Response.json(health);
}

export const POST = withErrorHandling(async (req) => {
  const { profile_id, job_id, label, prompt, num_predict, backfill } = await readJson(req);
  requireFields({ profile_id }, ['profile_id']);
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');

  if (backfill) {
    const n = await backfillEmbeddings(profile);
    return Response.json({ backfilled: n });
  }

  const job = job_id ? await get('SELECT * FROM jobs WHERE id = ?', [job_id]) : null;
  const question = label || prompt || '';
  const { hits } = await retrieve(profile, question, { k: 6 });
  const system = writeupSystemPrompt(profile, job, hits);
  const userMsg = label
    ? `Form field label on the application:\n"${label}"\n\nWrite the candidate's answer.`
    : prompt;
  try {
    const text = await chat(profile, [
      { role: 'system', content: system },
      { role: 'user', content: userMsg },
    ], { num_predict });
    return Response.json({ text, retrievedHits: hits.length });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 502 });
  }
});
