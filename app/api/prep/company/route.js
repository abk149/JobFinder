// Company-specific interview brief.
//   POST /api/prep/company { job_id }  → research the company and write a brief

import { get } from '../../../../lib/db.js';
import { buildCompanyBrief } from '../../../../lib/prep/company.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../../lib/http.js';
import { lcmd } from '../../../../lib/logger.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

export const POST = withErrorHandling(async (req) => {
  const { job_id } = await readJson(req);
  requireFields({ job_id }, ['job_id']);

  const job = await get('SELECT * FROM jobs WHERE id = ?', [job_id]);
  if (!job) throw new HttpError(404, 'job not found');
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [job.profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');

  lcmd(job.profile_id, `▶ Interview brief for ${job.company || 'this company'}`);
  const result = await buildCompanyBrief(profile, job);
  return Response.json(result);
});
