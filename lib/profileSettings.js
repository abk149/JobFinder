// Tiny helper to read stealth / LLM / bio settings out of profile.filters JSON.
//
// Robust against three failure modes we've hit:
//   1. filters is null/undefined          (new profile)
//   2. filters is a JS object             (PG JSONB driver auto-parses)
//   3. filters is double-stringified      (legacy bad data from when PUT handler
//                                          re-stringified an already-string body.filters)

export function parseFilters(profile) {
  let v = profile?.filters;
  if (v == null) return {};
  if (typeof v === 'object') return v;
  // Could be stringified up to 3 levels deep (double/triple-encoded legacy rows).
  for (let i = 0; i < 3 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v); } catch { return {}; }
  }
  return v && typeof v === 'object' ? v : {};
}

/** Normalize whatever the API receives in `body.filters` to a single-level JSON string. */
export function serializeFilters(value) {
  if (value == null) return '{}';
  if (typeof value === 'string') {
    // If it's already a JSON string, accept it as-is (after a parse round-trip to sanity-check).
    try {
      const parsed = parseFilters({ filters: value });
      return JSON.stringify(parsed);
    } catch { return '{}'; }
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return '{}';
}

export function isStealthEnabled(profile) {
  // Stealth (anti-bot patches via rebrowser-playwright) is ALWAYS on. There is
  // intentionally no user-facing toggle: the old toggle was confusing and left
  // profiles stuck in a stale `filters.stealth=false` state with no way back.
  // Login, scan, apply and autofill all share one stealth browser per site
  // (see lib/browser.js getContext / openLogin); the user logs in there once and
  // every later action reuses that same authenticated, stealthed session.
  //
  // We deliberately ignore any persisted `filters.stealth` value so legacy rows
  // that stored `false` can't disable stealth anymore.
  return true;
}
