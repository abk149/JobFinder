// Fit scoring + cross-connector de-duplication.
//
//   POST /api/fit { profile_id }  → score every job, collapse duplicates, cache results
//   GET  /api/fit?profile_id=X    → the candidate skill profile we scored against
//
// Deterministic and CPU-only, so scoring the whole table takes well under a second
// even at several hundred jobs. No LLM, no network.

import { get, all, run } from '../../../lib/db.js';
import { candidateSkillProfile, scoreAll, canonicalJobKey } from '../../../lib/fit.js';
import { listAnswers } from '../../../lib/answerBank.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';
import { lcmd, linfo, lok, lwarn } from '../../../lib/logger.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const profileId = searchParams.get('profile_id');
  if (!profileId) return Response.json({ error: 'profile_id required' }, { status: 400 });
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profileId]);
  if (!profile) return Response.json({ error: 'profile not found' }, { status: 404 });

  const answers = await listAnswers(profileId).catch(() => []);
  const cand = candidateSkillProfile(profile, answers);
  return Response.json({
    skills: [...cand.skills].sort(),
    level: cand.level?.name || null,
    locations: cand.locations,
    hasCv: cand.hasCv,
    sources: cand.sources,
  });
}

export const POST = withErrorHandling(async (req) => {
  const { profile_id } = await readJson(req);
  requireFields({ profile_id }, ['profile_id']);
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');

  const started = Date.now();
  lcmd(profile_id, '▶ Scoring job fit');

  const answers = await listAnswers(profile_id).catch(() => []);
  const cand = candidateSkillProfile(profile, answers);

  if (!cand.hasCv) {
    lwarn(profile_id, '  No CV text yet — scores will be low-confidence. Upload a PDF or paste your CV in Profile.');
  }
  linfo(profile_id, `  Your profile: ${cand.skills.size} skill(s), level=${cand.level?.name || 'unknown'}`);

  const jobs = await all(
    'SELECT id, title, company, location, url, description, posted_at, discovered_at, status FROM jobs WHERE profile_id = ?',
    [profile_id]
  );
  if (!jobs.length) {
    lwarn(profile_id, '  No jobs to score — run a scan first.');
    return Response.json({ ok: true, scored: 0, duplicates: 0 });
  }

  // ── 1. De-duplicate across connectors ────────────────────────────────────
  // The DB's uniqueness is (profile, connector, external_id), so the same role from
  // three boards is three rows. We group by a normalised company+title key and keep
  // the richest row (longest description) as the primary.
  const groups = new Map();
  for (const j of jobs) {
    const key = canonicalJobKey(j);
    if (!key) continue; // not enough signal — never risk merging distinct jobs
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(j);
  }
  let duplicates = 0;
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => (b.description || '').length - (a.description || '').length);
    duplicates += rows.length - 1;
    for (const r of rows) {
      await run('UPDATE jobs SET canonical_key = ? WHERE id = ?', [key, r.id]).catch(() => {});
    }
  }
  // Tag singletons too so the UI can group consistently.
  for (const [key, rows] of groups) {
    if (rows.length === 1) await run('UPDATE jobs SET canonical_key = ? WHERE id = ?', [key, rows[0].id]).catch(() => {});
  }
  if (duplicates) lok(profile_id, `  Found ${duplicates} duplicate listing(s) across sources.`);

  // ── 2. Score everything ──────────────────────────────────────────────────
  const scored = scoreAll(jobs, cand);
  for (const { job, fit } of scored) {
    await run('UPDATE jobs SET fit_score = ?, fit_json = ? WHERE id = ?', [
      fit.score,
      JSON.stringify({
        matched: fit.matched, missing: fit.missing, reasons: fit.reasons,
        band: fit.band, confidence: fit.confidence, jobLevel: fit.jobLevel,
        requiredCount: fit.requiredCount,
      }),
      job.id,
    ]).catch(() => {});
  }

  const bands = scored.reduce((a, s) => { a[s.fit.band] = (a[s.fit.band] || 0) + 1; return a; }, {});
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  lcmd(
    profile_id,
    `■ Scored ${scored.length} job(s) in ${secs}s — strong:${bands.strong || 0} possible:${bands.possible || 0} weak:${bands.weak || 0}` +
    (duplicates ? `, ${duplicates} duplicate(s) grouped` : '')
  );

  return Response.json({
    ok: true,
    scored: scored.length,
    duplicates,
    bands,
    candidate: { skills: [...cand.skills].sort(), level: cand.level?.name || null, hasCv: cand.hasCv },
    seconds: Number(secs),
  });
});
