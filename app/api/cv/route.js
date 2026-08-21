// CV variant management.
//
//   GET    /api/cv?profile_id=X            → list variants (+ their detected skills)
//   GET    /api/cv?profile_id=X&job_id=Y   → rank variants for that job
//   POST   /api/cv  (multipart)            → upload a new variant
//   PATCH  /api/cv { id, label?, makeDefault?, cv_text? }
//   DELETE /api/cv?profile_id=X&id=Y

import { get } from '../../../lib/db.js';
import {
  saveVariant, listVariants, deleteVariant, setDefaultVariant,
  updateVariantText, rankVariantsForJob,
} from '../../../lib/cvVariants.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const profileId = searchParams.get('profile_id');
  const jobId = searchParams.get('job_id');
  if (!profileId) return Response.json({ error: 'profile_id required' }, { status: 400 });

  if (jobId) {
    const job = await get('SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!job) return Response.json({ error: 'job not found' }, { status: 404 });
    const ranked = await rankVariantsForJob(profileId, job);
    return Response.json({ ok: true, ...ranked });
  }

  return Response.json({ ok: true, variants: await listVariants(profileId) });
}

export const POST = withErrorHandling(async (req) => {
  const form = await req.formData();
  const profileId = form.get('profile_id');
  const label = form.get('label');
  const file = form.get('file');

  if (!profileId || typeof profileId !== 'string') throw new HttpError(400, 'profile_id required');
  const profile = await get('SELECT id FROM profiles WHERE id = ?', [profileId]);
  if (!profile) throw new HttpError(404, 'profile not found');
  if (!file || typeof file === 'string') throw new HttpError(400, 'no file uploaded');
  if (file.type && !file.type.includes('pdf')) throw new HttpError(400, 'must be a PDF');

  const saved = await saveVariant(profileId, file, label);
  return Response.json({ ok: true, ...saved });
});

export const PATCH = withErrorHandling(async (req) => {
  const { profile_id, id, label, makeDefault, cv_text } = await readJson(req);
  requireFields({ profile_id, id }, ['profile_id', 'id']);

  if (makeDefault) await setDefaultVariant(profile_id, id);
  if (cv_text !== undefined) await updateVariantText(profile_id, id, cv_text);
  if (label !== undefined) {
    const { run } = await import('../../../lib/db.js');
    await run('UPDATE cv_variants SET label = ? WHERE id = ? AND profile_id = ?', [
      String(label).slice(0, 80), id, profile_id,
    ]);
  }
  return Response.json({ ok: true, variants: await listVariants(profile_id) });
});

export const DELETE = withErrorHandling(async (req) => {
  const { searchParams } = new URL(req.url);
  const profileId = searchParams.get('profile_id');
  const id = searchParams.get('id');
  if (!profileId || !id) throw new HttpError(400, 'profile_id and id required');
  const ok = await deleteVariant(profileId, id);
  if (!ok) throw new HttpError(404, 'variant not found');
  return Response.json({ ok: true, variants: await listVariants(profileId) });
});
