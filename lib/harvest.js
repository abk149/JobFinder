// Drain what the page observed while nothing was attached.
//
// The observer script buffers every field you fill into localStorage and snapshots
// the whole form on submit/unload. This is the Node half: on any attach, walk every
// open page and frame, take whatever accumulated, and write it to the answer bank.
//
// Why it matters: under lazy-attach, Playwright is only connected for the couple of
// seconds Autofill runs. Everything typed afterwards — corrections, the fields the
// LLM couldn't fill, the answers written right before hitting Submit — used to reach
// nothing. Those are exactly the answers worth learning, because they're the ones
// the bank didn't already have.

import { recordAnswer } from './answerBank.js';
import { lok, linfo } from './logger.js';

/**
 * Drain buffered observations from one frame.
 * @param includeCurrent also snapshot fields currently on screen, not just the buffer
 */
async function drainFrame(frame, includeCurrent) {
  try {
    return await frame.evaluate((snap) => {
      const out = [];
      if (typeof window.__jobfinderDrainBuffer === 'function') {
        out.push(...window.__jobfinderDrainBuffer());
      }
      if (snap && typeof window.__jobfinderSnapshotFilled === 'function') {
        out.push(...window.__jobfinderSnapshotFilled());
      }
      return out;
    }, includeCurrent);
  } catch {
    // Frame detached, cross-origin, or the script never installed there.
    return [];
  }
}

/**
 * Harvest across every open page/frame in a context and persist to the answer bank.
 *
 * @param includeCurrent when true, also capture fields currently visible (used by the
 *        explicit "Learn page" button so it works even if nothing was buffered yet).
 * @returns { learned, scannedFrames, samples }
 */
export async function harvestContext(ctx, profileId, { includeCurrent = false, quiet = false } = {}) {
  const collected = new Map(); // field_key -> entry (last write wins)
  let scannedFrames = 0;

  for (const page of ctx.pages()) {
    if (page.isClosed()) continue;
    for (const frame of page.frames()) {
      let url = '';
      try { url = frame.url(); } catch { continue; }
      if (!url || url === 'about:blank' || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) continue;
      scannedFrames++;
      for (const e of await drainFrame(frame, includeCurrent)) {
        if (!e || !e.field_key || !e.value) continue;
        collected.set(e.field_key, e);
      }
    }
  }

  let learned = 0;
  for (const entry of collected.values()) {
    try {
      await recordAnswer(profileId, entry);
      learned++;
    } catch { /* one bad row shouldn't stop the rest */ }
  }

  if (!quiet && learned) {
    const samples = [...collected.values()].slice(0, 4).map((e) => e.label || e.field_key);
    lok(profileId, `  📚 Learned ${learned} answer(s) from the page — ${samples.join(', ')}${collected.size > 4 ? '…' : ''}`);
  } else if (!quiet && scannedFrames) {
    linfo(profileId, '  Nothing new to learn from the page.');
  }

  return {
    learned,
    scannedFrames,
    samples: [...collected.values()].slice(0, 10).map((e) => ({ label: e.label, value: String(e.value).slice(0, 60) })),
  };
}
