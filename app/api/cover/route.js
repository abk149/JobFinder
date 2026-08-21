// Cover letters.
//   GET  ?profile_id=…                 → the profile's base template
//   GET  ?profile_id=…&job_id=…        → the tailored letter for that job (cached)
//   POST { profile_id, template }      → save the base template
//   POST { profile_id, job_id, mode }  → generate/regenerate a tailored letter
//   POST { profile_id, job_id, text }  → save an edited letter for that job

import { get, run } from '../../../lib/db.js';
import { coverLetterFor, saveProfileCoverLetter, renderTemplate } from '../../../lib/coverLetter.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../lib/http.js';
import { lcmd, lok } from '../../../lib/logger.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const GET = withErrorHandling(async (req) => {
  const { searchParams } = new URL(req.url);
  const profile_id = searchParams.get('profile_id');
  requireFields({ profile_id }, ['profile_id']);
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');

  const job_id = searchParams.get('job_id');
  if (!job_id) return Response.json({ ok: true, template: profile.cover_letter || '' });

  const job = await get('SELECT * FROM jobs WHERE id = ?', [job_id]);
  if (!job) throw new HttpError(404, 'job not found');
  return Response.json({
    ok: true,
    text: job.cover_letter || '',
    preview: renderTemplate(profile.cover_letter || '', { job, profile }),
    cached: !!job.cover_letter,
  });
});

export const POST = withErrorHandling(async (req) => {
  const { profile_id, job_id, template, text, mode = 'regenerate' } = await readJson(req);
  requireFields({ profile_id }, ['profile_id']);
  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');

  // Save the base template.
  if (template !== undefined && !job_id) {
    const saved = await saveProfileCoverLetter(profile_id, template);
    return Response.json({ ok: true, template: saved });
  }

  requireFields({ job_id }, ['job_id']);
  const job = await get('SELECT * FROM jobs WHERE id = ?', [job_id]);
  if (!job) throw new HttpError(404, 'job not found');

  // Save an edited letter verbatim — your wording wins over anything generated.
  if (typeof text === 'string' && text.trim()) {
    await run('UPDATE jobs SET cover_letter = ? WHERE id = ?', [text.trim(), job_id]);
    return Response.json({ ok: true, text: text.trim(), source: 'edited' });
  }

  lcmd(profile_id, `▶ Cover letter for "${job.title || job_id}"${job.company ? ' @ ' + job.company : ''}`);
  const r = await coverLetterFor(profile, job, { mode });
  lok(profile_id, `  ✓ Cover letter ready (${r.source}, ${String(r.text).split(/\s+/).filter(Boolean).length} words)`);
  return Response.json({ ok: true, ...r });
});
