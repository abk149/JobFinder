// In-memory resume cache. Keyed by profile_id -> { buffer, filename, mtime }.
// Lazily hydrated from disk on first read.

import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths.js';

const cache = new Map();

export function resumeDir(profileId) {
  const p = dataPath('resumes', profileId);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export async function saveResume(profileId, file) {
  const dir = resumeDir(profileId);
  // Wipe any prior resume so we always have one canonical file
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  const filename = sanitize(file.name || 'resume.pdf');
  const buffer = Buffer.from(await file.arrayBuffer());
  const full = path.join(dir, filename);
  fs.writeFileSync(full, buffer);
  cache.set(profileId, { buffer, filename, path: full, mtime: Date.now() });
  return { filename, path: full, size: buffer.length };
}

export function getResume(profileId) {
  if (cache.has(profileId)) return cache.get(profileId);
  const dir = resumeDir(profileId);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith('.')) : [];
  if (!files.length) return null;
  const filename = files[0];
  const full = path.join(dir, filename);
  const buffer = fs.readFileSync(full);
  const entry = { buffer, filename, path: full, mtime: fs.statSync(full).mtimeMs };
  cache.set(profileId, entry);
  return entry;
}

export function clearResume(profileId) {
  cache.delete(profileId);
  const dir = resumeDir(profileId);
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
}

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

// Attempt to attach the cached resume to any visible file input on the page.
// Returns true if attached. Safe to call when there's no input (no-op).
export async function attachResumeToPage(page, profileId) {
  const entry = getResume(profileId);
  if (!entry) return false;
  return attachBuffer(page, entry.filename, entry.buffer);
}

async function attachBuffer(page, filename, buffer) {
  try {
    const input = page.locator('input[type="file"]').first();
    if (await input.count()) {
      await input.setInputFiles({ name: filename, mimeType: 'application/pdf', buffer });
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Attach the CV that best matches this specific job.
 *
 * Prefers a scored variant (see lib/cvVariants.js); falls back to the single legacy
 * résumé when the profile has no variants, so existing setups keep working.
 *
 * @returns { attached, label, coverage, reason } — the reasoning is returned so the
 *          autofill log can say WHICH CV went out and why, rather than silently
 *          uploading a file the user didn't choose.
 */
export async function attachBestResumeToPage(page, profileId, job) {
  // Imported lazily: cvVariants imports the skills dictionary, and resume.js is
  // pulled in by the connectors, so a static import would drag that whole graph
  // into every scan.
  let best = null;
  try {
    const { bestVariantFor } = await import('./cvVariants.js');
    best = await bestVariantFor(profileId, job || {});
  } catch { /* variants unavailable — fall through to the legacy résumé */ }

  if (best?.buffer) {
    const ok = await attachBuffer(page, best.filename, best.buffer);
    return {
      attached: ok,
      label: best.label,
      coverage: best.coverage,
      matched: best.matched?.length || 0,
      requiredCount: best.requiredCount,
      alternatives: best.alternatives || [],
      source: 'variant',
    };
  }

  const entry = getResume(profileId);
  if (!entry) return { attached: false, reason: 'no CV uploaded' };
  const ok = await attachBuffer(page, entry.filename, entry.buffer);
  return { attached: ok, label: entry.filename, source: 'single' };
}
