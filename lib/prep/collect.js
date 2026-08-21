// Raw-material collection for the interview-prep engine.
//
// This gathers SOURCE MATERIAL only — it does no synthesis. The synthesizer
// (lib/prep/synthesize.js) reads what lands here and writes genuinely new study
// material from it.
//
// Sources, in rough order of signal quality:
//   1. The user's own saved jobs — real descriptions for the roles they're chasing.
//      Highest-signal input we have and it's already local (zero network).
//   2. Hacker News — interview / hiring discussion threads via the Algolia API.
//   3. Reddit — r/cscareerquestions, r/ExperiencedDevs etc. Best-effort: Reddit
//      403s plain server requests from some IPs, so failure here is non-fatal.
//   4. Images found in the above, run through a local vision model when one is
//      installed (see lib/prep/vision.js).

import crypto from 'node:crypto';
import { all, run } from '../db.js';
import { htmlToText } from '../../connectors/_util.js';
import { describeImageUrl } from './vision.js';
import { linfo, lwarn, lok } from '../logger.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function getJson(url, timeoutMs = 20000) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** Stable id so re-collecting the same item doesn't duplicate rows. */
function sourceId(profileId, kind, key) {
  return crypto.createHash('sha1').update(`${profileId}|${kind}|${key}`).digest('hex').slice(0, 20);
}

// ── 1. The user's own target roles ─────────────────────────────────────────

async function fromOwnJobs(profile, limit = 25) {
  const rows = await all(
    `SELECT id, title, company, location, url, description FROM jobs
      WHERE profile_id = ? AND description IS NOT NULL AND description != ''
      ORDER BY discovered_at DESC LIMIT ?`,
    [profile.id, limit]
  );
  return rows.map((j) => ({
    kind: 'job',
    key: j.id,
    title: `${j.title}${j.company ? ' @ ' + j.company : ''}`,
    url: j.url || '',
    content: htmlToText(j.description, 4000),
  }));
}

// ── 2. Hacker News interview discussions ───────────────────────────────────

async function fromHackerNews(topics, perTopic = 6) {
  const out = [];
  for (const topic of topics.slice(0, 5)) {
    const q = encodeURIComponent(`${topic} interview`);
    const data = await getJson(
      `https://hn.algolia.com/api/v1/search?query=${q}&tags=story&hitsPerPage=${perTopic}`
    );
    for (const hit of data?.hits || []) {
      const text = [hit.title, hit.story_text || '', hit._highlightResult?.title?.value || '']
        .filter(Boolean)
        .join('\n');
      if (!hit.objectID || !hit.title) continue;
      out.push({
        kind: 'hn',
        key: String(hit.objectID),
        title: hit.title,
        url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
        content: htmlToText(text, 3000),
        meta: { topic, points: hit.points, comments: hit.num_comments },
      });
    }
    // Pull the top comments of the highest-scoring thread — that's where the actual
    // interview experiences live, not the title.
    const best = (data?.hits || []).sort((a, b) => (b.num_comments || 0) - (a.num_comments || 0))[0];
    if (best?.objectID) {
      const item = await getJson(`https://hn.algolia.com/api/v1/items/${best.objectID}`);
      for (const c of (item?.children || []).slice(0, 15)) {
        const t = htmlToText(c.text || '', 2000);
        if (t.length < 120) continue; // skip one-liners
        out.push({
          kind: 'hn',
          key: `c${c.id}`,
          title: `Comment on: ${best.title}`,
          url: `https://news.ycombinator.com/item?id=${c.id}`,
          content: t,
          meta: { topic, parent: best.objectID },
        });
      }
    }
  }
  return out;
}

// ── 3. Reddit interview subreddits (best-effort) ───────────────────────────

const PREP_SUBS = ['cscareerquestions', 'ExperiencedDevs', 'interviews', 'leetcode'];

async function fromReddit(topics, ctx = null) {
  const out = [];
  // Try each topic as a search across the prep subreddits.
  for (const topic of topics.slice(0, 3)) {
    const q = encodeURIComponent(`${topic} interview`);
    for (const sub of PREP_SUBS.slice(0, 2)) {
      const data = await getJson(
        `https://www.reddit.com/r/${sub}/search.json?q=${q}&restrict_sr=1&sort=top&t=year&limit=10`
      );
      for (const wrap of data?.data?.children || []) {
        const p = wrap?.data;
        if (!p?.id || !p.title) continue;
        const body = htmlToText(p.selftext || '', 3000);
        if (body.length < 150) continue;
        out.push({
          kind: 'reddit',
          key: p.id,
          title: p.title,
          url: `https://www.reddit.com${p.permalink}`,
          content: body,
          meta: { topic, sub, score: p.score },
        });
      }
    }
  }
  return out;
}

// ── 4. Images (optional, needs a local vision model) ───────────────────────

const IMG_RE = /https?:\/\/[^\s"')]+\.(?:png|jpe?g|webp|gif)/gi;

async function enrichWithImages(profile, sources, pid, maxImages = 4) {
  let done = 0;
  for (const s of sources) {
    if (done >= maxImages) break;
    const urls = (s.content || '').match(IMG_RE) || [];
    for (const u of urls.slice(0, 1)) {
      if (done >= maxImages) break;
      const desc = await describeImageUrl(
        profile,
        u,
        'Transcribe all text in this image. If it shows an interview question, coding problem, architecture diagram, or compensation table, describe it precisely.'
      );
      if (desc) {
        s.content += `\n\n[IMAGE CONTENT — ${u}]\n${desc}`;
        done++;
        lok(pid, `    🖼  Extracted text from image in "${(s.title || '').slice(0, 40)}"`);
      }
    }
  }
  return done;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Derive the study topics for a profile: their keywords plus the most common
 * companies/titles among the jobs they've actually saved.
 */
export async function deriveTopics(profile) {
  const kws = (profile.keywords || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const rows = await all(
    `SELECT title, company FROM jobs WHERE profile_id = ? ORDER BY discovered_at DESC LIMIT 60`,
    [profile.id]
  );
  const companies = {};
  for (const r of rows) {
    const c = (r.company || '').trim();
    if (c && c.length < 40) companies[c] = (companies[c] || 0) + 1;
  }
  const topCompanies = Object.entries(companies)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c]) => c);

  const topics = [...kws, ...topCompanies];
  return topics.length ? topics : ['software engineer'];
}

/**
 * Collect fresh raw material for a profile and persist it into prep_sources.
 * Idempotent: re-running updates existing rows rather than duplicating.
 *
 * @returns { collected, byKind, topics, imagesExtracted }
 */
export async function collectSources(profile, { withImages = true, ctx = null } = {}) {
  const pid = profile.id;
  const topics = await deriveTopics(profile);
  linfo(pid, `  Topics: ${topics.join(', ')}`);

  const groups = await Promise.all([
    fromOwnJobs(profile).catch(() => []),
    fromHackerNews(topics).catch(() => []),
    fromReddit(topics, ctx).catch(() => []),
  ]);

  const [jobs, hn, reddit] = groups;
  linfo(pid, `  Collected — own jobs: ${jobs.length}, HN: ${hn.length}, Reddit: ${reddit.length}`);
  if (reddit.length === 0) {
    lwarn(pid, '  Reddit returned nothing (it rate-limits server requests) — continuing without it.');
  }

  const sources = [...jobs, ...hn, ...reddit];

  let imagesExtracted = 0;
  if (withImages) {
    imagesExtracted = await enrichWithImages(profile, sources, pid);
    if (imagesExtracted === 0) {
      linfo(pid, '  No image content extracted (no vision model installed, or no images found).');
    }
  }

  const now = Date.now();
  for (const s of sources) {
    const id = sourceId(pid, s.kind, s.key);
    try {
      await run(
        `INSERT INTO prep_sources (id, profile_id, kind, title, url, content, meta, collected_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, url=excluded.url, content=excluded.content,
           meta=excluded.meta, collected_at=excluded.collected_at`,
        [id, pid, s.kind, s.title || '', s.url || '', s.content || '', JSON.stringify(s.meta || {}), now]
      );
    } catch {
      /* one bad row shouldn't abort collection */
    }
  }

  const byKind = sources.reduce((acc, s) => {
    acc[s.kind] = (acc[s.kind] || 0) + 1;
    return acc;
  }, {});
  return { collected: sources.length, byKind, topics, imagesExtracted };
}
