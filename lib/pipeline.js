// Application pipeline: statuses, follow-up scheduling, and funnel analytics.
//
// The original model was a flat flag (new / in_progress / applied / skipped). That's
// enough to remember what you clicked, but not to run a job search — it can't tell
// you that you applied 12 days ago and nobody replied, and it can't tell you whether
// your problem is volume (too few applications) or quality (applications that never
// convert). Both are decisions you have to make weekly with a three-month runway.

export const STAGES = [
  { key: 'new',         label: 'New',         terminal: false, counts: false },
  { key: 'shortlisted', label: 'Shortlisted', terminal: false, counts: false },
  { key: 'in_progress', label: 'In progress', terminal: false, counts: false },
  { key: 'applied',     label: 'Applied',     terminal: false, counts: true  },
  { key: 'screening',   label: 'Screening',   terminal: false, counts: true  },
  { key: 'interview',   label: 'Interview',   terminal: false, counts: true  },
  { key: 'offer',       label: 'Offer',       terminal: true,  counts: true  },
  { key: 'rejected',    label: 'Rejected',    terminal: true,  counts: true  },
  { key: 'skipped',     label: 'Skipped',     terminal: true,  counts: false },
  { key: 'error',       label: 'Error',       terminal: true,  counts: false },
];

export const STAGE_KEYS = STAGES.map((s) => s.key);

// Rank within the funnel, used to stop a job sliding backwards. The terminal
// stages sit outside the progression — reopening a skipped or rejected job is a
// deliberate retry, not a regression — so they rank -1.
const TERMINAL_RETRY = new Set(['rejected', 'skipped', 'error']);
export function stageRank(key) {
  if (TERMINAL_RETRY.has(key)) return -1;
  const i = STAGE_KEYS.indexOf(key);
  return i < 0 ? -1 : i;
}

/**
 * Should `next` replace `current`? Opening a job you have ALREADY applied to must not
 * knock it back to "in progress" — that loses real pipeline state and the applied date.
 * Retrying something you skipped or were rejected from is fine.
 */
export function shouldAdvance(current, next) {
  return stageRank(next) > stageRank(current);
}
export function isValidStage(s) { return STAGE_KEYS.includes(s); }

// Default follow-up interval per stage, in days. Chosen from ordinary hiring rhythm:
// a week is long enough not to nag, short enough that you're still remembered.
const FOLLOW_UP_DAYS = {
  applied: 10,
  screening: 5,
  interview: 3,
  offer: 2,
};

/** When should the next nudge be, given a stage transition? null = no follow-up. */
export function defaultFollowUp(stage, from = Date.now()) {
  const days = FOLLOW_UP_DAYS[stage];
  if (!days) return null;
  return from + days * 86400000;
}

/**
 * Funnel metrics from a set of job rows.
 *
 * The conversion rates are the point. With ~0% reply rate the fix is the CV, not
 * more applications — and that's a very different week's work.
 */
export function funnel(jobs) {
  const byStage = {};
  for (const s of STAGE_KEYS) byStage[s] = 0;
  for (const j of jobs) {
    const s = isValidStage(j.status) ? j.status : 'new';
    byStage[s]++;
  }

  // Anyone who reached screening or beyond replied to you at some point, including
  // people who later rejected you after a conversation.
  const applied = byStage.applied + byStage.screening + byStage.interview + byStage.offer + byStage.rejected;
  const responded = byStage.screening + byStage.interview + byStage.offer;
  const interviewed = byStage.interview + byStage.offer;

  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);

  return {
    byStage,
    totals: {
      tracked: jobs.length,
      applied,
      responded,
      interviewed,
      offers: byStage.offer,
      rejected: byStage.rejected,
    },
    rates: {
      responseRate: pct(responded, applied),
      interviewRate: pct(interviewed, applied),
      offerRate: pct(byStage.offer, applied),
    },
    // Plain-language read of what the numbers imply. Deliberately conservative:
    // small samples say "not enough data" rather than inventing a diagnosis.
    diagnosis: diagnose(applied, responded, interviewed, byStage.offer),
  };
}

function diagnose(applied, responded, interviewed, offers) {
  if (applied < 10) {
    return {
      level: 'info',
      text: `Only ${applied} application${applied === 1 ? '' : 's'} tracked so far — too few to read anything into. Aim for 15-20 before judging your conversion.`,
    };
  }
  const rr = responded / applied;
  if (rr === 0) {
    return {
      level: 'warn',
      text: `${applied} applications, zero responses. That points at the CV or targeting, not volume. Run the CV gap check on a few strong-fit roles before applying to more.`,
    };
  }
  if (rr < 0.05) {
    return {
      level: 'warn',
      text: `Response rate is ${Math.round(rr * 100)}% — low. Typical tailored applications land 10-20%. Prioritise fit score and tailor the CV rather than increasing volume.`,
    };
  }
  if (interviewed > 0 && offers === 0 && interviewed >= 3) {
    return {
      level: 'warn',
      text: `You're converting to interviews (${interviewed}) but not offers. The bottleneck is interview performance — use mock questions in the Prep tab.`,
    };
  }
  return {
    level: 'ok',
    text: `Response rate ${Math.round(rr * 100)}% across ${applied} applications. That's a healthy funnel — keep the volume up.`,
  };
}

/** Jobs whose follow-up date has arrived, most overdue first. */
export function dueFollowUps(jobs, now = Date.now()) {
  return jobs
    .filter((j) => j.follow_up_at && j.follow_up_at <= now && !['rejected', 'skipped', 'offer', 'error'].includes(j.status))
    .map((j) => ({ ...j, overdueDays: Math.floor((now - j.follow_up_at) / 86400000) }))
    .sort((a, b) => a.follow_up_at - b.follow_up_at);
}
