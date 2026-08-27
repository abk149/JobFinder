// The scan itself, independent of who asked for it.
//
// Extracted from the API route so the auto-apply SCHEDULER can scan too. Without that
// the schedule applied to whatever was already in the database and, once it had worked
// through the fresh postings, quietly did nothing — it looked like "no new jobs" when
// the truth was that nothing had gone looking for any. One implementation, so the
// scheduled path cannot drift from the one you trigger by hand.

import crypto from 'node:crypto';
import { harvestFromJob } from './contacts.js';
import { get, run } from './db.js';
import { getContext, openLogin } from './browser.js';
import { CONNECTORS, getConnector } from '../connectors/index.js';
import { isStealthEnabled } from './profileSettings.js';
import { lcmd, linfo, lok, lwarn, lerr } from './logger.js';
import { canonicalJobKey } from './fit.js';

/**
 * Scan `connectors` (all of them when omitted) for one profile.
 *
 * @returns {Promise<{results: Array, needsYou: Array}>}
 */
export async function scanConnectors(profile, connectors) {
  const profile_id = profile.id;
  const targets = (connectors && connectors.length ? connectors.map(getConnector).filter(Boolean) : CONNECTORS);

  lcmd(profile_id, `▶ Scan ${targets.length} source(s)`);
  const scanStart = Date.now();

  // ── Interrupt you only when you are actually needed ────────────────────────
  //
  // The scan itself is headless and silent. The one thing it cannot do on your
  // behalf is sign in or clear a human-check, so those — and nothing else — raise
  // a real window.
  //
  // Capped at ONE window per scan. Without the cap a scan where the LinkedIn cookie
  // had expired would open a window for `linkedin`, another for `linkedinposts`, and
  // another for `naukri`, which is the pile-up this whole change exists to stop. One
  // sign-in usually fixes the rest anyway, and the log still names every source.
  let attentionRaised = false;
  const needsYou = [];
  async function requestAttention(c, kind, message) {
    needsYou.push({ connector: c.id, kind, message });
    if (attentionRaised) {
      lwarn(profile_id, `  ⚠ ${c.id}: also needs you — ${message}`);
      return;
    }
    attentionRaised = true;
    lwarn(profile_id, `  🔔 ${c.id}: opening a window — ${message}`);
    try {
      await openLogin(profile_id, c.id, c.loginUrl, { stealth: isStealthEnabled(profile) });
    } catch (e) {
      lerr(profile_id, `  ✗ could not open the sign-in window: ${e?.message || e}`);
    }
  }

  // Split connectors into two pools so we can parallelize aggressively where it's
  // safe and serialize where it isn't.
  //   • API connectors (requiresBrowser=false): pure HTTP, fully independent → run
  //     them ALL in parallel.
  //   • Browser connectors: share ONE off-screen Chrome window per profile. Tabs in
  //     the same window are cheap, but kicking off too many simultaneously starves
  //     the renderer. Cap at 3 in flight.
  const apiTargets     = targets.filter((c) => c.requiresBrowser === false);
  const browserTargets = targets.filter((c) => c.requiresBrowser !== false);

  async function runOne(c) {
    const runId = crypto.randomUUID();
    const startedAt = Date.now();
    await run(
      'INSERT INTO scan_runs (id, profile_id, connector, started_at) VALUES (?,?,?,?)',
      [runId, profile_id, c.id, startedAt]
    );
    let found = 0;      // rows actually inserted (genuinely new)
    let contactsFound = 0;  // hiring addresses the ads printed themselves
    let fetched = 0;    // rows the source returned before keyword filtering
    let matched = 0;    // rows that survived keyword filtering
    let error = null;
    linfo(profile_id, `  ${c.requiresBrowser === false ? '⚡' : '🌐'} ${c.id}: starting…`);
    try {
      const needsBrowser = c.requiresBrowser !== false;
      // Scanning runs headless, in its own browser directory, with a copy of your
      // cookies. It never opens a window and never takes focus, so a scan can run
      // while you work. (The previous "off-screen window" was not off-screen at all —
      // macOS clamped it back on top of whatever you were doing.)
      const ctx = needsBrowser
        ? await getContext(profile_id, c.id, { headless: true, stealth: isStealthEnabled(profile), offscreen: true })
        : null;
      // Hard per-connector budget. One slow or wedged source must never stall the
      // whole scan — previously LinkedIn and Naukri could sit in a 90s CAPTCHA wait
      // each and simply never report.
      // 120s was set when a browser connector loaded a handful of pages. They now walk
      // several feeds each — Naukri reads five recommendation tabs, LinkedIn four search
      // feeds — and a measured Naukri scan takes ~100s, which is close enough to the old
      // ceiling that a slow morning would time the whole thing out and discard every job
      // it had already collected. Raised with headroom rather than trimmed to fit.
      const budgetMs = needsBrowser ? 240000 : 45000;
      const jobs = await Promise.race([
        c.scan(ctx, profile),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`timed out after ${budgetMs / 1000}s`)), budgetMs)
        ),
      ]);
      // `fetched` is the pre-filter count. Connectors opt in by returning
      // withFetched(out, n); those that don't leave it undefined, and we must not
      // then pretend post-filter == pre-filter.
      fetched = jobs.fetched;
      matched = jobs.length;
      for (const j of jobs) {
        try {
          // canonical_key collapses the same role scraped from several boards into
          // one entry. Set at insert so freshly-scanned jobs dedupe immediately,
          // without waiting for a fit-scoring pass.
          // A repeat posting still updates ONE thing: apply_kind. Learning that a job
          // redirects to the employer's own site is worth keeping the moment we know
          // it, so auto-apply never spends a place in a batch rediscovering it. Nothing
          // else is touched — a rescan must not overwrite your pipeline state.
          //
          // res.changes is therefore no longer a reliable "was this new?" signal, so
          // newness is decided by checking for the row first.
          // Was this posting already known? Asked BEFORE the upsert, because the
          // upsert now also updates apply_kind on existing rows, so "rows changed"
          // no longer distinguishes a new job from a re-seen one.
          const already = await get(
            'SELECT 1 AS x FROM jobs WHERE profile_id = ? AND connector = ? AND external_id = ?',
            [profile_id, c.id, j.external_id]
          );
          await run(
            `INSERT INTO jobs (id, profile_id, connector, external_id, title, company, location, url, salary, posted_at, description, raw_json, status, discovered_at, canonical_key, apply_kind)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(profile_id, connector, external_id) DO UPDATE
               SET apply_kind = COALESCE(EXCLUDED.apply_kind, jobs.apply_kind)`,
            [
              j.id, profile_id, c.id, j.external_id,
              j.title || '', j.company || '', j.location || '',
              j.url || '', j.salary || '', j.posted_at || '',
              j.description || '', JSON.stringify(j),
              'new', Date.now(), canonicalJobKey(j) || null,
              // Known up front for Naukri; null everywhere else, and filled in lazily
              // by auto-apply the first time it opens the posting.
              j.apply_kind || null,
            ]
          );
          if (!already) {
            found++;
            // Harvest any hiring address the ad printed itself ("send your CV to …").
            // Only on genuinely new rows, so re-scanning doesn't re-walk the archive.
            try {
              const c = await harvestFromJob(profile_id, j);
              contactsFound += c.added;
            } catch { /* a bad address must never fail a scan */ }
          }
        } catch (e) {
          // ignore single-row errors
        }
      }
    } catch (e) {
      error = String(e?.message || e);
      // 'blocked' is deliberately excluded — you cannot click your way out of an IP
      // ban, so raising a window for it would be pure interruption.
      if ((e?.wall === 'login' || e?.wall === 'captcha') && c.loginUrl) {
        await requestAttention(c, e.wall, error);
      }
    }
    await run(
      'UPDATE scan_runs SET finished_at=?, found=?, error=? WHERE id=?',
      [Date.now(), found, error, runId]
    );

    // Report all three numbers. A bare "0" is ambiguous and was the single most
    // confusing thing about the old log: it looked identical whether the source
    // was broken, your keywords excluded everything, or you simply already had
    // every job it offers.
    const took = ((Date.now() - startedAt) / 1000).toFixed(1);
    const knowsFetched = typeof fetched === 'number';
    if (error) {
      lerr(profile_id, `  ✗ ${c.id}: ${error} (${took}s)`);
    } else if (matched === 0) {
      // Only claim the source is dead when we can actually prove it offered nothing.
      if (knowsFetched && fetched > 0) {
        lwarn(profile_id, `  – ${c.id}: offered ${fetched} job(s), none matched your keywords (${took}s)`);
      } else if (knowsFetched) {
        lwarn(profile_id, `  – ${c.id}: source returned nothing — likely down or blocking us (${took}s)`);
      } else {
        lwarn(profile_id, `  – ${c.id}: no jobs — either the source is down or your keywords excluded everything (${took}s)`);
      }
    } else if (found === 0) {
      linfo(profile_id, `  = ${c.id}: ${matched} match(es), all already saved (${took}s)`);
    } else {
      const of = knowsFetched ? ` of ${fetched} offered` : '';
      // Mention harvested contacts only when there are some — most sources publish none.
      const contactNote = contactsFound ? ` · ${contactsFound} hiring contact${contactsFound === 1 ? '' : 's'}` : '';
      lok(profile_id, `  ✓ ${c.id}: ${found} new — ${matched} matched${of}${contactNote} (${took}s)`);
    }
    return { connector: c.id, found, fetched: knowsFetched ? fetched : null, matched, contacts: contactsFound, error };
  }

  // pMap-style concurrency limiter for browser scans.
  async function withLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    });
    await Promise.all(workers);
    return out;
  }

  const [apiResults, browserResults] = await Promise.all([
    Promise.all(apiTargets.map(runOne)),
    withLimit(browserTargets, 3, runOne),
  ]);
  // Preserve the original target order in the response.
  const byId = new Map([...apiResults, ...browserResults].map((r) => [r.connector, r]));
  const results = targets.map((c) => byId.get(c.id)).filter(Boolean);

  const totalFound = results.reduce((s, r) => s + (r.found || 0), 0);
  lcmd(profile_id, `■ Scan done — ${totalFound} new job${totalFound === 1 ? '' : 's'} across ${results.length} sources in ${((Date.now() - scanStart) / 1000).toFixed(1)}s`);
  if (needsYou.length) {
    lwarn(profile_id, `  🔔 ${needsYou.length} source(s) need you to sign in: ${needsYou.map((n) => n.connector).join(', ')}`);
  }
  return { results, needsYou };
}
