// Shared secret for the in-page toolbar.
//
// The toolbar has to run on the job site's own page (naukri.com, myworkdayjobs.com…),
// so its calls to JobFinder are cross-origin and need CORS. That is a real exposure:
// with a plain `Access-Control-Allow-Origin: *`, ANY site you browse could drive your
// local automation — fill forms, harvest what you typed — just by fetching localhost.
//
// So /api/quickfill accepts a token that only exists in your bookmarklet. Sites can
// reach the endpoint but cannot produce the token, and the token is never present in
// any page's DOM or JavaScript — it lives in the bookmark URL you keep.
//
// It is stored beside the database rather than regenerated per boot, so the bookmark
// keeps working across restarts.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataPath } from './paths.js';

const FILE = dataPath('.quicktoken');
let cached = '';

export function quickToken() {
  if (cached) return cached;
  try {
    cached = fs.readFileSync(FILE, 'utf8').trim();
    if (cached) return cached;
  } catch { /* not created yet */ }
  cached = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, cached, { mode: 0o600 });
  } catch { /* in-memory only if the disk is read-only */ }
  return cached;
}

/** Constant-time compare, so the token can't be guessed a byte at a time. */
export function tokenValid(given) {
  const want = quickToken();
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** CORS for the toolbar only. Echoes the caller's origin; no credentials. */
export function corsHeaders(req) {
  const origin = req.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Vary': 'Origin',
  };
}
