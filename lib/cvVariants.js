// Multiple CV variants per profile, with automatic best-fit selection.
//
// One CV cannot serve a backend role, an AI/ML role and an engineering-management
// role. Keeping several and sending whichever matches best is one of the highest-
// leverage things a candidate can do — but only if the right one is picked
// automatically, because manually choosing per application is exactly the friction
// that makes people give up and send the generic one.
//
// Selection is DETERMINISTIC: each variant's extracted text is matched against the
// posting's required skills, and the variant with the best coverage wins. No LLM —
// picking a file must be instant and reproducible, and you need to be able to see
// why it chose what it chose.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { all, get, run } from './db.js';
import { extractPdfText } from './pdftext.js';
import { matchSkillsInText } from './prep/skills.js';
import { htmlToText } from '../connectors/_util.js';
import { dataPath } from './paths.js';

function variantsDir(profileId) {
  const p = dataPath('resumes', profileId, 'variants');
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function sanitize(name) {
  return String(name || 'cv.pdf').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

/** Save a new CV variant, extracting its text for scoring. */
export async function saveVariant(profileId, file, label) {
  const id = crypto.randomUUID();
  const filename = sanitize(file.name || 'cv.pdf');
  const buffer = Buffer.from(await file.arrayBuffer());
  const full = path.join(variantsDir(profileId), `${id}.pdf`);
  fs.writeFileSync(full, buffer);

  const extraction = extractPdfText(buffer);
  const cvText = extraction.ok ? extraction.text.slice(0, 40000) : '';

  const existing = await all('SELECT id FROM cv_variants WHERE profile_id = ?', [profileId]);
  await run(
    `INSERT INTO cv_variants (id, profile_id, label, filename, path, cv_text, is_default, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      id, profileId,
      String(label || filename.replace(/\.pdf$/i, '')).slice(0, 80),
      filename, full, cvText,
      existing.length === 0 ? 1 : 0, // first one uploaded becomes the fallback
      Date.now(),
    ]
  );

  return {
    id, label, filename, size: buffer.length,
    extracted: extraction.ok,
    chars: cvText.length,
    reason: extraction.ok ? null : extraction.reason,
    skills: extraction.ok ? matchSkillsInText(cvText).map((s) => s.skill) : [],
  };
}

export async function listVariants(profileId) {
  const rows = await all(
    'SELECT id, label, filename, cv_text, is_default, created_at FROM cv_variants WHERE profile_id = ? ORDER BY is_default DESC, created_at ASC',
    [profileId]
  );
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    filename: r.filename,
    isDefault: !!r.is_default,
    chars: (r.cv_text || '').length,
    hasText: (r.cv_text || '').replace(/\s/g, '').length > 200,
    skills: matchSkillsInText(r.cv_text || '').map((s) => s.skill),
    createdAt: r.created_at,
  }));
}

export async function deleteVariant(profileId, id) {
  const row = await get('SELECT path, is_default FROM cv_variants WHERE id = ? AND profile_id = ?', [id, profileId]);
  if (!row) return false;
  try { if (row.path && fs.existsSync(row.path)) fs.unlinkSync(row.path); } catch { /* ignore */ }
  await run('DELETE FROM cv_variants WHERE id = ?', [id]);
  // Never leave a profile with variants but no default.
  if (row.is_default) {
    const next = await get('SELECT id FROM cv_variants WHERE profile_id = ? ORDER BY created_at ASC LIMIT 1', [profileId]);
    if (next) await run('UPDATE cv_variants SET is_default = 1 WHERE id = ?', [next.id]);
  }
  return true;
}

export async function setDefaultVariant(profileId, id) {
  await run('UPDATE cv_variants SET is_default = 0 WHERE profile_id = ?', [profileId]);
  await run('UPDATE cv_variants SET is_default = 1 WHERE id = ? AND profile_id = ?', [id, profileId]);
}

export async function updateVariantText(profileId, id, cvText) {
  await run('UPDATE cv_variants SET cv_text = ? WHERE id = ? AND profile_id = ?', [
    String(cvText || '').slice(0, 40000), id, profileId,
  ]);
}

/**
 * Score every variant against one job and return them ranked.
 *
 * Coverage = share of the posting's required skills the CV actually names. Ties are
 * broken by absolute matches (a CV covering 6/8 beats one covering 3/4), because the
 * broader CV genuinely evidences more.
 *
 * @returns { ranked:[{id,label,coverage,matched,missing,score}], best, required }
 */
export async function rankVariantsForJob(profileId, job) {
  const rows = await all(
    'SELECT id, label, filename, cv_text, is_default FROM cv_variants WHERE profile_id = ?',
    [profileId]
  );
  if (!rows.length) return { ranked: [], best: null, required: [] };

  const jd = htmlToText(job.description || '', 9000);
  const required = [
    ...new Set([
      ...matchSkillsInText(jd).map((s) => s.skill),
      ...matchSkillsInText(job.title || '').map((s) => s.skill),
    ]),
  ];

  const ranked = rows.map((r) => {
    const inCv = new Set(matchSkillsInText(r.cv_text || '').map((s) => s.skill));
    const matched = required.filter((s) => inCv.has(s));
    const missing = required.filter((s) => !inCv.has(s));
    const coverage = required.length ? Math.round((matched.length / required.length) * 100) : null;
    return {
      id: r.id,
      label: r.label,
      filename: r.filename,
      isDefault: !!r.is_default,
      hasText: (r.cv_text || '').replace(/\s/g, '').length > 200,
      coverage,
      matched,
      missing,
      // Sort key: coverage first, then raw match count as the tiebreak.
      score: (coverage ?? 0) * 100 + matched.length,
    };
  });

  ranked.sort((a, b) => b.score - a.score);

  // If the posting has no recognisable requirements, coverage is meaningless —
  // fall back to the user's designated default rather than an arbitrary winner.
  let best = ranked[0] || null;
  if (!required.length) {
    best = ranked.find((r) => r.isDefault) || ranked[0] || null;
  }
  return { ranked, best, required };
}

/** Load the raw PDF bytes for a variant. */
export async function variantFile(profileId, id) {
  const row = await get('SELECT label, filename, path FROM cv_variants WHERE id = ? AND profile_id = ?', [id, profileId]);
  if (!row || !row.path || !fs.existsSync(row.path)) return null;
  return { label: row.label, filename: row.filename, buffer: fs.readFileSync(row.path) };
}

/**
 * Pick the best variant for a job and return its file, with the reasoning.
 * Returns null when the profile has no variants (caller falls back to the single
 * legacy résumé).
 */
export async function bestVariantFor(profileId, job) {
  const { ranked, best, required } = await rankVariantsForJob(profileId, job);
  if (!best) return null;
  const file = await variantFile(profileId, best.id);
  if (!file) return null;
  return {
    ...best,
    buffer: file.buffer,
    filename: file.filename,
    requiredCount: required.length,
    alternatives: ranked.slice(1, 4).map((r) => ({ label: r.label, coverage: r.coverage })),
  };
}
