// How recently was a job posted?
//
// `posted_at` arrives in whatever shape each source emits. Live in this database:
//   "2026-06-04T12:53:39-04:00"        ISO with offset      (techstartups)
//   "2026-08-05T15:55:30.000Z"         ISO with Z           (arbeitnow)
//   "2026-07-09T08:01:56"              bare ISO, no zone    (remotive)
//   "Tue, 21 Jul 2026 15:35:41 +0000"  RFC-2822             (weworkremotely)
//   "1 month ago" / "3 days ago"       relative text        (some scrapers)
//
// And ~24% of rows have none at all — naukri, linkedin, indeed, ycombinator and
// wellfound simply don't publish one on their listing pages.
//
// So freshness reports its BASIS as well as its age. A job we first saw today is
// probably new, but saying "posted today" when the source never told us would be a
// claim we cannot support — and acting on a wrong "posted" date costs you the first-mover
// advantage this feature exists to give.

// Accepts both "3 days ago" and the compact "3d" / "2h" LinkedIn renders inline.
// "mo" must be tested before "m", or months would be read as minutes.
const RELATIVE = /^(?:about\s+)?(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|mo|[mhdwy])\s*(ago)?$/i;
const UNIT_MS = {
  minute: 60e3, minutes: 60e3, min: 60e3, mins: 60e3, m: 60e3,
  hour: 3600e3, hours: 3600e3, hr: 3600e3, hrs: 3600e3, h: 3600e3,
  day: 86400e3, days: 86400e3, d: 86400e3,
  week: 7 * 86400e3, weeks: 7 * 86400e3, w: 7 * 86400e3,
  month: 30 * 86400e3, months: 30 * 86400e3, mo: 30 * 86400e3,
  year: 365 * 86400e3, years: 365 * 86400e3, y: 365 * 86400e3,
};

/** Parse any of the shapes above into epoch ms, or 0 if unusable. */
export function parsePostedAt(value) {
  if (!value) return 0;
  const s = String(value).trim();
  if (!s) return 0;

  const rel = s.match(RELATIVE);
  if (rel) {
    const ms = UNIT_MS[rel[2].toLowerCase().replace(/s$/, '') === 'mo' ? 'mo' : rel[2].toLowerCase()];
    if (ms) return Date.now() - Number(rel[1]) * ms;
  }
  if (/^just now|^today$/i.test(s)) return Date.now();
  if (/^yesterday$/i.test(s)) return Date.now() - 86400e3;

  // Date handles ISO (zoned, Z, and bare) plus RFC-2822 natively.
  const t = Date.parse(s);
  if (Number.isFinite(t)) {
    // Guard against clearly bogus values (epoch 0, far future).
    if (t < 946684800000) return 0;            // before 2000 → junk
    if (t > Date.now() + 86400e3) return 0;    // more than a day ahead → junk
    return t;
  }
  return 0;
}

/**
 * @returns {{ at:number, basis:'posted'|'seen', ageDays:number|null }}
 *   basis 'posted' — the source told us when it was published
 *   basis 'seen'   — it did not, so this is when the scan first found it
 */
export function freshnessOf(job) {
  const posted = parsePostedAt(job?.posted_at);
  if (posted) {
    return { at: posted, basis: 'posted', ageDays: (Date.now() - posted) / 86400e3 };
  }
  const seen = Number(job?.discovered_at) || 0;
  return {
    at: seen,
    basis: 'seen',
    ageDays: seen ? (Date.now() - seen) / 86400e3 : null,
  };
}

/** Is this job within `days`? `strict` requires a real published date. */
export function isFresh(job, days = 7, { strict = false } = {}) {
  const f = freshnessOf(job);
  if (f.ageDays == null) return false;
  if (strict && f.basis !== 'posted') return false;
  return f.ageDays <= days;
}

/** "2h ago" / "3d ago" — compact enough for a dense list. */
export function shortAge(ms) {
  if (!ms) return '';
  const d = Math.max(0, Date.now() - ms);
  if (d < 3600e3) return `${Math.max(1, Math.round(d / 60e3))}m ago`;
  if (d < 86400e3) return `${Math.round(d / 3600e3)}h ago`;
  return `${Math.round(d / 86400e3)}d ago`;
}
