// Company-specific interview brief.
//
// Skill prep tells you what to study. This tells you what to know about the company
// you're sitting in front of on Thursday: what they actually do, what their stack
// looks like, how they run interviews, and — the part candidates most often fluff —
// intelligent questions to ask them.
//
// Sources are the same keyless, citable set used elsewhere (Wikipedia, Hacker News,
// Reddit, dev.to), scoped to the company name, plus the job description itself,
// which is the single most reliable statement of what they want.

import crypto from 'node:crypto';
import { get, run } from '../db.js';
import { chat } from '../llm.js';
import { indexNote } from './kb.js';
import { matchSkillsInText } from './skills.js';
import { htmlToText } from '../../connectors/_util.js';
import { linfo, lok, lwarn } from '../logger.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function getJson(url, timeoutMs = 15000) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function strip(s, max = 1400) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&\w+;/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.search(/[[{]/);
  if (start === -1) return null;
  const open = t[start]; const close = open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === open) depth++;
    else if (t[i] === close) { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/** Only keep sources whose title actually names the company. */
function mentions(company, title) {
  const c = company.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  if (c.length < 3) return false;
  return String(title || '').toLowerCase().includes(c);
}

async function researchCompany(company, pid) {
  const out = [];

  const wiki = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(company.replace(/\s+/g, '_'))}`);
  if (wiki?.extract && !String(wiki.type || '').includes('disambiguation')) {
    out.push({
      purpose: 'background', kind: 'wikipedia', title: wiki.title,
      url: wiki.content_urls?.desktop?.page || '', content: wiki.extract,
    });
  }

  // HN is where engineers talk candidly about companies — outages, culture, stack.
  const hn = await getJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(company)}&tags=story&hitsPerPage=12`);
  for (const h of hn?.hits || []) {
    if (!h.title || !mentions(company, h.title)) continue;
    if ((h.points || 0) < 5) continue;
    out.push({
      purpose: 'background', kind: 'hacker news', title: h.title,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      content: strip(h.story_text || h.title, 900),
    });
    if (out.length >= 8) break;
  }

  // Interview experiences.
  const rd = await getJson(`https://www.reddit.com/search.json?q=${encodeURIComponent(`${company} interview`)}&sort=top&t=all&limit=10`);
  for (const w of rd?.data?.children || []) {
    const p = w?.data;
    if (!p?.title || !mentions(company, p.title)) continue;
    const body = strip(p.selftext || '', 1600);
    if (body.length < 100) continue;
    out.push({
      purpose: 'interview', kind: 'reddit', title: p.title,
      url: `https://www.reddit.com${p.permalink}`, content: body,
    });
    if (out.filter((s) => s.purpose === 'interview').length >= 4) break;
  }

  if (pid) {
    const byPurpose = out.reduce((a, s) => { a[s.purpose] = (a[s.purpose] || 0) + 1; return a; }, {});
    linfo(pid, `    researched "${company}": ${out.length} source(s) ${JSON.stringify(byPurpose)}`);
  }
  return out;
}

/**
 * Build (or refresh) an interview brief for the company behind a job.
 * Stored as a prep note of kind 'company' so it shows up alongside skill notes and
 * is searchable by the Q&A bot.
 */
export async function buildCompanyBrief(profile, job) {
  const pid = profile.id;
  const company = (job.company || '').trim();
  if (!company) return { ok: false, reason: 'This posting has no company name.' };

  linfo(pid, `  🏢 Building interview brief for ${company}…`);
  const sources = await researchCompany(company, pid);

  const jd = htmlToText(job.description || '', 4000);
  const stack = matchSkillsInText(jd).map((s) => s.skill);

  const material = sources.length
    ? sources.map((s, i) => `[${i + 1}] (${s.kind}) ${s.title}\nURL: ${s.url}\n${s.content}`).join('\n\n')
    : '(no external sources found — rely on the job description)';

  let bio = '';
  try {
    const f = typeof profile.filters === 'string' ? JSON.parse(profile.filters) : profile.filters || {};
    bio = f.bio || '';
  } catch { /* ignore */ }

  const system = [
    'You are preparing a candidate for an interview at one specific company.',
    'You are given the job description, the tech stack detected in it, and numbered sources about the company.',
    '',
    'Be concrete and useful. If the sources are thin, say what is known versus what is inference — do not pad with generic corporate description.',
    'Cite sources inline as [1], [2]. Only cite numbers that exist.',
    '',
    'Produce a JSON object with exactly these keys:',
    '{',
    '  "what_they_do": "2-4 sentences on the business and how it makes money, cited where possible",',
    '  "tech_context": "what their engineering environment looks like, inferred from the posting and sources",',
    '  "likely_process": "what their interview process probably involves, based on sources; say if unknown",',
    '  "talking_points": ["3-5 specific things to mention that show you did real homework"],',
    '  "questions_to_ask": ["4-6 sharp questions to ask THEM — specific to this company, not generic filler"],',
    '  "risks": ["2-3 honest concerns a candidate should probe: churn, funding, on-call load, whatever the sources suggest"]',
    '}',
    'Respond with ONLY the JSON object.',
  ].join('\n');

  const user = [
    `COMPANY: ${company}`,
    `ROLE: ${job.title || ''}`,
    stack.length ? `TECH DETECTED IN POSTING: ${stack.join(', ')}` : '',
    bio ? `\nCANDIDATE BACKGROUND (pitch the level):\n${bio}` : '',
    `\nJOB DESCRIPTION:\n${jd}`,
    `\nSOURCES:\n${material}`,
  ].filter(Boolean).join('\n');

  let brief = null;
  for (let attempt = 1; attempt <= 2 && !brief; attempt++) {
    const raw = await chat(profile, [
      { role: 'system', content: attempt === 1 ? system : system + '\nIMPORTANT: output a single JSON object and nothing else.' },
      { role: 'user', content: user },
    ], { num_predict: attempt === 1 ? 1700 : 1300, temperature: 0.35, json: true, useSynthModel: true });
    const parsed = extractJson(raw);
    if (parsed && (parsed.what_they_do || parsed.questions_to_ask)) brief = parsed;
  }
  if (!brief) {
    lwarn(pid, `  ⚠ Could not build a brief for ${company}.`);
    return { ok: false, reason: 'The model did not return usable JSON. Try again.' };
  }

  const body = [
    `## ${company} — interview brief`,
    '',
    brief.what_they_do || '',
    '',
    brief.tech_context ? `**Engineering context**\n${brief.tech_context}` : '',
    '',
    brief.likely_process ? `**Their process**\n${brief.likely_process}` : '',
    '',
    brief.talking_points?.length ? '**Talking points**\n' + brief.talking_points.map((k) => `- ${k}`).join('\n') : '',
    '',
    brief.questions_to_ask?.length ? '**Ask them**\n' + brief.questions_to_ask.map((k) => `- ${k}`).join('\n') : '',
    '',
    brief.risks?.length ? '**Probe these**\n' + brief.risks.map((k) => `- ${k}`).join('\n') : '',
  ].filter((s) => s !== '').join('\n');

  const id = crypto.createHash('sha1').update(`${pid}|company|${company.toLowerCase()}`).digest('hex').slice(0, 20);
  const now = Date.now();
  await run(
    `INSERT INTO prep_notes (id, profile_id, topic, kind, title, body, source_ids, created_at, day, evidence, demand, sources_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET body=excluded.body, created_at=excluded.created_at, sources_json=excluded.sources_json`,
    [
      id, pid, company, 'company', `${company} — interview brief`, body, '[]', now,
      new Date().toISOString().slice(0, 10),
      `You have a saved job at ${company}: ${job.title || ''}`, 0,
      JSON.stringify({
        references: sources.map((s, i) => ({ n: i + 1, kind: s.kind, title: s.title, url: s.url, purpose: s.purpose })),
        jobs: [{ title: job.title, company, url: job.url }],
      }),
    ]
  );
  await indexNote(profile, { id, topic: company, title: `${company} interview brief`, body }).catch(() => {});
  lok(pid, `  ✓ Brief ready for ${company} — ${sources.length} source(s)`);

  return { ok: true, company, noteId: id, body, sources, brief };
}
