// Interview-prep API.
//
//   GET  /api/prep?profile_id=X    → notes + stats + vision capability
//   POST /api/prep { profile_id }  → collect fresh material and re-synthesize
//
// The POST is the "update my study material" action. It's slow (many LLM calls),
// so progress is streamed to the per-profile log bus and shown in the terminal panel.

import { get, all } from '../../../lib/db.js';
import { buildPrep } from '../../../lib/prep/synthesize.js';
import { prepStats, backfillPrepEmbeddings } from '../../../lib/prep/kb.js';
import { visionCapability } from '../../../lib/prep/vision.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';
import { lcmd, linfo, lok, lwarn } from '../../../lib/logger.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 900; // synthesis across ~6 topics on an 8B model takes a while

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const profileId = searchParams.get('profile_id');
  if (!profileId) return Response.json({ error: 'profile_id required' }, { status: 400 });

  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profileId]);
  if (!profile) return Response.json({ error: 'profile not found' }, { status: 404 });

  const notes = await all(
    `SELECT id, topic, kind, title, body, created_at, day, evidence, demand, sources_json
       FROM prep_notes WHERE profile_id = ?
      ORDER BY CASE kind WHEN 'daily' THEN 0 ELSE 1 END, demand DESC, created_at DESC`,
    [profileId]
  );
  const stats = await prepStats(profileId);
  const vision = await visionCapability(profile);

  return Response.json({ notes, stats, vision });
}

export const POST = withErrorHandling(async (req) => {
  const { profile_id, withImages = true } = await readJson(req);
  requireFields({ profile_id }, ['profile_id']);
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');

  const started = Date.now();
  lcmd(profile_id, '▶ Refreshing interview prep material');
  linfo(profile_id, '  Stage 1 — extracting required skills from your saved job descriptions…');

  // Skills come from the JDs; each skill is then researched and written up with
  // citations. No topic exists unless a real job ad asked for it.
  const synth = await buildPrep(profile);

  linfo(profile_id, '  Stage 2 — indexing into the prep knowledge base…');
  const backfilled = await backfillPrepEmbeddings(profile).catch(() => 0);
  if (backfilled) linfo(profile_id, `  Backfilled ${backfilled} embedding(s).`);

  const stats = await prepStats(profile_id);
  const secs = ((Date.now() - started) / 1000).toFixed(0);

  if (synth.reason === 'no-jobs') {
    lwarn(profile_id, '■ No saved jobs with descriptions — run a Scan first so prep has real requirements to read.');
  } else if (synth.notesWritten === 0) {
    lwarn(profile_id, `■ Prep refresh finished but wrote 0 notes in ${secs}s — check that Ollama is running.`);
  } else {
    lcmd(
      profile_id,
      `■ Prep refresh done — ${synth.notesWritten} skill(s), ${synth.sourcesStored} source(s) cited, in ${secs}s`
    );
  }

  return Response.json({ ok: true, synth, stats, seconds: Number(secs) });
});
