// CV gap analysis and per-job tailoring.
//
//   GET  /api/tailor?job_id=X   → instant, deterministic gap analysis (no LLM)
//   POST /api/tailor { job_id } → LLM-generated tailored summary + bullet rewrites
//
// The GET is separated deliberately: seeing "your CV covers 3/11 of this posting's
// requirements" is useful immediately and shouldn't cost a two-minute model call.

import { get } from '../../../lib/db.js';
import { analyseGap, tailorForJob } from '../../../lib/tailor.js';
import { listAnswers } from '../../../lib/answerBank.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';
import { lcmd, linfo, lok, lwarn } from '../../../lib/logger.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get('job_id');
  if (!jobId) return Response.json({ error: 'job_id required' }, { status: 400 });

  const job = await get('SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job) return Response.json({ error: 'job not found' }, { status: 404 });
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [job.profile_id]);
  if (!profile) return Response.json({ error: 'profile not found' }, { status: 404 });

  const answers = await listAnswers(job.profile_id).catch(() => []);
  const gap = analyseGap(job, profile, answers);
  return Response.json({ ok: true, gap, job: { id: job.id, title: job.title, company: job.company } });
}

export const POST = withErrorHandling(async (req) => {
  const { job_id } = await readJson(req);
  requireFields({ job_id }, ['job_id']);

  const job = await get('SELECT * FROM jobs WHERE id = ?', [job_id]);
  if (!job) throw new HttpError(404, 'job not found');
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [job.profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');
  const pid = job.profile_id;

  const answers = await listAnswers(pid).catch(() => []);
  const gap = analyseGap(job, profile, answers);

  lcmd(pid, `▶ Tailoring CV for "${job.title}"${job.company ? ' @ ' + job.company : ''}`);
  if (gap.coverage !== null) {
    linfo(pid, `  CV covers ${gap.coverage}% of this posting's requirements (ATS risk: ${gap.atsRisk})`);
  }
  if (gap.missingButEvidenced.length) {
    linfo(pid, `  Safe to surface (you have these, CV doesn't say them): ${gap.missingButEvidenced.join(', ')}`);
  }
  if (gap.missingEntirely.length) {
    linfo(pid, `  Genuine gaps (will NOT be claimed): ${gap.missingEntirely.join(', ')}`);
  }

  const result = await tailorForJob(job, profile, answers, gap);
  if (!result.ok) {
    lwarn(pid, `■ Tailoring failed: ${result.reason}`);
    return Response.json({ ok: false, ...result });
  }

  if (result.violations?.length) {
    // The prompt forbids claiming genuine gaps; this is the post-check catching it.
    lwarn(pid, `  ⚠ Draft mentions un-evidenced skill(s): ${result.violations.join(', ')} — review before using.`);
  }
  lok(pid, `■ Tailored draft ready — ${result.bullets?.length || 0} bullet rewrite(s), ${result.keywords_to_add?.length || 0} keyword(s) to add`);

  return Response.json({ ok: true, ...result });
});
