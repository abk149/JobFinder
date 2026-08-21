// Per-skill research — gathers RELEVANT, citable material for one specific skill.
//
// Two problems this fixes from the naive version:
//
//   1. NO RELEVANCE GATE. Blindly taking the top API results meant a search for
//      "Incident Response" returned "Android: Overlay on Android Camera Preview"
//      from Stack Overflow. Now every candidate must mention the skill in its title
//      or be dropped.
//
//   2. NO LEARNING PATH. Random forum threads don't teach you a topic. Each skill
//      now leads with its OFFICIAL DOCUMENTATION (curated in skills.js) and is
//      explicitly split by purpose so the UI can say "learn here" vs "interview
//      questions" vs "background discussion".
//
// Every source carries { purpose, kind, title, url } so the note can group them.

import { linfo } from '../logger.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function getJson(url, timeoutMs = 15000) {
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

function stripHtml(s, max = 1400) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

// ── Relevance gate ──────────────────────────────────────────────────────────

// Words too generic to signal relevance on their own. Critically this includes the
// filler inside multi-word skill names — matching only "protocol" from "Model
// Context Protocol" let "Why is HTTP2 a binary protocol?" through the gate.
const GENERIC = new Set([
  'the', 'and', 'for', 'with', 'from', 'programming', 'language', 'statistics',
  'testing', 'engineering', 'development', 'systems', 'system', 'data', 'api', 'apis',
  'protocol', 'context', 'model', 'models', 'response', 'management', 'generation',
  'architecture', 'design', 'driven', 'based', 'service', 'services', 'platform',
]);

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split a skill name into a PRIMARY term (the distinctive one) and SECONDARY tokens.
 *
 *   "Model Context Protocol (MCP)"          → primary "mcp",  secondary [] (all generic)
 *   "RAG (Retrieval-Augmented Generation)"  → primary "rag",  secondary ['retrieval','augmented']
 *   "Kubernetes"                            → primary "kubernetes"
 *   "Incident Response"                     → primary "incident response", secondary ['incident']
 */
function skillTerms(skill) {
  const paren = (skill.match(/\((.*?)\)/) || [])[1] || '';
  const main = skill.replace(/\(.*?\)/g, '').trim();

  const looksAcronym = (s) => s && s.length <= 10 && /^[A-Za-z0-9-]+$/.test(s) && s === s.toUpperCase();

  let primary;
  let rest;
  if (looksAcronym(paren)) { primary = paren; rest = main; }        // Model Context Protocol (MCP)
  else if (looksAcronym(main)) { primary = main; rest = paren; }    // RAG (Retrieval-Augmented Generation)
  else { primary = main; rest = main; }                             // Kubernetes / Incident Response

  const secondary = [...new Set(
    String(rest).toLowerCase().split(/[^a-z0-9+#.]+/)
      .map((t) => t.replace(/^\.+|\.+$/g, ''))
      .filter((t) => t.length >= 3 && !GENERIC.has(t))
  )];
  return { primary: primary.toLowerCase(), mainPhrase: main.toLowerCase(), secondary };
}

/**
 * A candidate is relevant if its TITLE either
 *   (a) contains the full skill phrase,
 *   (b) contains the primary/acronym term as a whole word, or
 *   (c) contains at least half of the distinctive secondary tokens.
 * Title-only on purpose — matching body text lets almost anything through.
 */
function isRelevant(skill, title, content = '') {
  const hay = String(title || '').toLowerCase();
  if (!hay) return false;
  const { primary, mainPhrase, secondary } = skillTerms(skill);

  // (a) exact phrase
  if (mainPhrase.length >= 4 && hay.includes(mainPhrase)) return true;

  // (b) primary term as a whole word — catches "RAG pipeline", "MCP servers"
  if (primary && new RegExp(`(?<![a-z0-9])${escRe(primary)}(?![a-z0-9])`, 'i').test(hay)) return true;

  // (c) enough distinctive secondary tokens
  if (secondary.length >= 2) {
    const hits = secondary.filter((t) => hay.includes(t)).length;
    if (hits >= Math.ceil(secondary.length / 2)) return true;
  }
  return false;
}

// ── Source adapters ─────────────────────────────────────────────────────────

/** Official documentation — curated per skill, always relevant, always first. */
function officialDocs(skill, docsUrl) {
  if (!docsUrl) return [];
  let host = '';
  try { host = new URL(docsUrl).hostname.replace(/^www\./, ''); } catch { return []; }
  return [{
    purpose: 'learn',
    kind: 'official docs',
    title: `${skill} — official documentation (${host})`,
    url: docsUrl,
    content: `Primary reference for ${skill}. Start here to learn the material properly.`,
  }];
}

async function fromWikipedia(skill) {
  const base = skill.replace(/\(.*?\)/g, '').trim();
  const s = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(base.replace(/\s+/g, '_'))}`);
  if (s?.extract && !String(s.type || '').includes('disambiguation')) {
    return [{
      purpose: 'learn',
      kind: 'wikipedia',
      title: s.title,
      url: s.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(base)}`,
      content: s.extract,
    }];
  }
  return [];
}

/** Interview questions specifically — this is what the user is preparing for. */
async function interviewMaterial(skill, n = 4) {
  const base = skill.replace(/\(.*?\)/g, '').trim();
  const out = [];

  // Reddit tends to have real "I was asked X" threads.
  const rd = await getJson(
    `https://www.reddit.com/search.json?q=${encodeURIComponent(`${base} interview questions`)}&sort=top&t=all&limit=8`
  );
  for (const w of rd?.data?.children || []) {
    const p = w?.data;
    if (!p?.title) continue;
    if (!isRelevant(skill, p.title, p.selftext || '')) continue;
    const body = stripHtml(p.selftext || '', 1400);
    if (body.length < 80) continue;
    out.push({
      purpose: 'interview',
      kind: 'reddit',
      title: p.title,
      url: `https://www.reddit.com${p.permalink}`,
      content: body,
      meta: { score: p.score, sub: p.subreddit },
    });
    if (out.length >= n) break;
  }

  // Stack Overflow, but ONLY questions whose title actually names the skill.
  if (out.length < n) {
    const so = await getJson(
      `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=votes&q=${encodeURIComponent(base)}&site=stackoverflow&pagesize=8&filter=withbody`
    );
    for (const it of so?.items || []) {
      if (!it.title || !isRelevant(skill, it.title)) continue;
      out.push({
        purpose: 'interview',
        kind: 'stackoverflow',
        title: it.title,
        url: it.link,
        content: stripHtml(it.body, 1300),
        meta: { score: it.score },
      });
      if (out.length >= n) break;
    }
  }
  return out;
}

/** Practitioner discussion — the "what actually bites you in production" material. */
async function fromHackerNews(skill, n = 3) {
  const base = skill.replace(/\(.*?\)/g, '').trim();
  const data = await getJson(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(base)}&tags=story&hitsPerPage=12`
  );
  const out = [];
  for (const h of data?.hits || []) {
    if (!h.title || !isRelevant(skill, h.title)) continue;
    if ((h.points || 0) < 10) continue; // low-signal noise
    out.push({
      purpose: 'discussion',
      kind: 'hacker news',
      title: h.title,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      content: stripHtml(h.story_text || h.title, 1100),
      meta: { points: h.points, comments: h.num_comments },
    });
    if (out.length >= n) break;
  }
  return out;
}

/** Tutorial-style articles. */
async function fromDevTo(skill, n = 2) {
  const base = skill.replace(/\(.*?\)/g, '').trim();
  let arr = await getJson(`https://dev.to/api/articles/search?q=${encodeURIComponent(base)}&per_page=10`);
  if (!Array.isArray(arr) || !arr.length) {
    const tag = base.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (tag) arr = await getJson(`https://dev.to/api/articles?tag=${encodeURIComponent(tag)}&per_page=10`);
  }
  const out = [];
  for (const a of Array.isArray(arr) ? arr : []) {
    if (!a?.title || !a?.url || !isRelevant(skill, a.title, a.description || '')) continue;
    out.push({
      purpose: 'learn',
      kind: 'dev.to',
      title: a.title,
      url: a.url,
      content: stripHtml(a.description || a.title, 700),
      meta: { reactions: a.public_reactions_count },
    });
    if (out.length >= n) break;
  }
  return out;
}

/** LinkedIn posts — only when a logged-in browser context is supplied. */
async function fromLinkedIn(ctx, skill, n = 2) {
  if (!ctx) return [];
  let page;
  try {
    const base = skill.replace(/\(.*?\)/g, '').trim();
    page = await ctx.newPage();
    await page.goto(
      `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(`${base} interview`)}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    await page.waitForTimeout(2500);
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 1500).catch(() => {}); await page.waitForTimeout(700); }
    const posts = await page.evaluate(() => {
      const res = [];
      for (const el of document.querySelectorAll('div.feed-shared-update-v2, div[data-urn*="urn:li:activity"]')) {
        const id = ((el.getAttribute('data-urn') || '').match(/urn:li:activity:(\d+)/) || [])[1] || '';
        const text = (el.querySelector('.update-components-text, span[dir="ltr"]')?.innerText || '').trim();
        if (text.length < 150) continue;
        res.push({ id, text: text.slice(0, 1800) });
        if (res.length >= 10) break;
      }
      return res;
    }).catch(() => []);
    return posts
      .filter((p) => isRelevant(skill, p.text.slice(0, 160), p.text))
      .slice(0, n)
      .map((p) => ({
        purpose: 'discussion',
        kind: 'linkedin',
        title: p.text.split('\n')[0].slice(0, 110),
        url: p.id ? `https://www.linkedin.com/feed/update/urn:li:activity:${p.id}/` : 'https://www.linkedin.com/feed/',
        content: p.text,
      }));
  } catch {
    return [];
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Gather relevant, citable material for one skill.
 *
 * @param skill    canonical skill name from skills.js
 * @param docsUrl  curated official-docs URL for that skill
 * @returns [{purpose,kind,title,url,content,meta}] — official docs first
 */
export async function researchSkill(skill, { docsUrl = '', ctx = null, pid = null } = {}) {
  const groups = await Promise.all([
    Promise.resolve(officialDocs(skill, docsUrl)),
    fromWikipedia(skill).catch(() => []),
    interviewMaterial(skill).catch(() => []),
    fromHackerNews(skill).catch(() => []),
    fromDevTo(skill).catch(() => []),
    fromLinkedIn(ctx, skill).catch(() => []),
  ]);

  const merged = [];
  const seen = new Set();
  for (const g of groups) {
    for (const s of g) {
      if (!s.url || seen.has(s.url)) continue;
      seen.add(s.url);
      merged.push(s);
    }
  }

  if (pid) {
    const byPurpose = merged.reduce((a, s) => { a[s.purpose] = (a[s.purpose] || 0) + 1; return a; }, {});
    const dropped = merged.length === 0 ? ' (nothing passed the relevance gate)' : '';
    linfo(pid, `      researched "${skill}": ${merged.length} relevant source(s) ${JSON.stringify(byPurpose)}${dropped}`);
  }
  return merged;
}
