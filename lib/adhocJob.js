// Paste-a-link: turn any job URL into a first-class job row.
//
// Scanning only ever finds what the 21 connectors cover. The rest of the time a job
// reaches you some other way — a friend's link, a newsletter, a company careers page —
// and until now none of the machinery (autofill, cover letters, CV matching, the
// tracker) could touch it. This closes that gap: paste a URL and it becomes a normal
// job, indistinguishable downstream from a scanned one.
//
// EXTRACTION LADDER, most reliable first:
//   1. JSON-LD schema.org/JobPosting — what Google indexes, so most boards and every
//      major ATS emit it. Verified live on Jobspresso and NoDesk: full title, hiring
//      organisation and a 7-9k character description.
//   2. OpenGraph meta tags — always present, but og:title often carries site branding.
//   3. <h1> plus the visible body text.
//   4. The LLM, given the page text, when the structured routes come up empty.
//
// The page is loaded in YOUR Chrome, not a fresh headless one, so a posting behind a
// login (LinkedIn, Naukri) or a bot check reads exactly as it does for you.

import crypto from 'node:crypto';
import { get, run } from './db.js';
import { chat } from './llm.js';
import { htmlToText } from '../connectors/_util.js';
import { linfo, lok, lwarn } from './logger.js';

/** Runs inside the page. Returns whatever structured data the site offers. */
const SCRAPE = `(() => {
  const out = { jsonld: null, og: {}, h1: '', title: document.title || '', text: '' };
  try {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(s.textContent);
        const arr = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
        const jp = arr.find((x) => String(x && x['@type'] || '').includes('JobPosting'));
        if (jp) {
          let loc = '';
          const L = jp.jobLocation;
          const one = Array.isArray(L) ? L[0] : L;
          if (one && one.address) {
            const a = one.address;
            loc = [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(', ');
          }
          if (!loc && jp.jobLocationType) loc = 'Remote';
          let salary = '';
          const bs = jp.baseSalary && jp.baseSalary.value;
          if (bs) salary = [bs.minValue, bs.maxValue].filter(Boolean).join('-') + ' ' + (jp.baseSalary.currency || '');
          out.jsonld = {
            title: jp.title || '',
            company: (jp.hiringOrganization && jp.hiringOrganization.name) || '',
            location: loc,
            salary: salary.trim(),
            datePosted: jp.datePosted || '',
            description: jp.description || '',
          };
          break;
        }
      } catch (e) {}
    }
  } catch (e) {}
  try {
    for (const m of document.querySelectorAll('meta[property^="og:"], meta[name^="og:"]')) {
      out.og[m.getAttribute('property') || m.getAttribute('name')] = m.content || '';
    }
  } catch (e) {}
  try { out.h1 = (document.querySelector('h1') || {}).innerText || ''; } catch (e) {}
  try {
    const main = document.querySelector('main, article, [role=main], #content, .content') || document.body;
    out.text = (main.innerText || '').slice(0, 12000);
  } catch (e) {}
  return out;
})()`;

function clean(s, max = 200) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Ask the model only for what the page didn't tell us structurally. */
async function llmExtract(profile, { text, url, known }) {
  if (!text || text.length < 200) return {};
  const system = [
    'You extract job-posting metadata from page text. Respond with ONLY a JSON object:',
    '{ "title": "the role title alone, no company or location",',
    '  "company": "the hiring company",',
    '  "location": "location or Remote",',
    '  "description": "the responsibilities and requirements, verbatim from the page, up to 4000 characters" }',
    'Use "" for anything the page does not state. Never guess a company from the domain.',
  ].join('\n');
  try {
    const raw = await chat(profile, [
      { role: 'system', content: system },
      { role: 'user', content: `URL: ${url}\nAlready known: ${JSON.stringify(known)}\n\nPAGE TEXT:\n${text.slice(0, 9000)}` },
    ], { num_predict: 2200, temperature: 0.1, json: true, useSynthModel: true, timeoutMs: 180000 });
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : {};
  } catch {
    return {};
  }
}

/**
 * Read one already-open page and build a job record from it.
 * @param page a Playwright Page already sitting on the posting
 */
export async function extractJobFromPage(page, profile, url) {
  let raw = {};
  try { raw = await page.evaluate(SCRAPE); } catch { raw = {}; }

  const ld = raw.jsonld || {};
  let title = clean(ld.title, 160);
  let company = clean(ld.company, 120);
  let location = clean(ld.location, 120);
  let salary = clean(ld.salary, 60);
  let posted = clean(ld.datePosted, 60);
  let description = htmlToText(ld.description || '', 6000);

  // OpenGraph / <h1> fill the gaps. og:title usually appends " at Company" or " | Site",
  // so trim the tail rather than trusting it whole.
  if (!title) {
    const og = clean(raw.og?.['og:title'] || raw.h1 || raw.title, 200);
    title = clean(og.split(/\s+[|–—]\s+/)[0].replace(/^remote\s+/i, ''), 160);
  }
  if (!company) {
    const og = clean(raw.og?.['og:site_name'], 120);
    const atMatch = clean(raw.og?.['og:title'] || raw.title, 200).match(/\bat\s+([^|–—]+)$/i);
    company = clean(atMatch ? atMatch[1] : og, 120);
  }
  if (!description) description = htmlToText(raw.og?.['og:description'] || '', 6000);
  if (!description || description.length < 400) {
    const body = clean(raw.text, 6000);
    if (body.length > description.length) description = body;
  }

  // Only involve the model when the page genuinely didn't say.
  const thin = !title || !company || description.length < 300;
  if (thin && profile) {
    linfo(profile.id, '  Page had little structured data — asking the LLM to read it…');
    const g = await llmExtract(profile, { text: raw.text, url, known: { title, company, location } });
    title = title || clean(g.title, 160);
    company = company || clean(g.company, 120);
    location = location || clean(g.location, 120);
    if ((g.description || '').length > description.length) description = htmlToText(g.description, 6000);
  }

  return {
    title: title || 'Untitled role',
    company: company || '',
    location: location || '',
    salary,
    posted_at: posted,
    description,
    hadStructuredData: !!raw.jsonld,
  };
}

/** Stable id for a pasted URL, so pasting twice updates rather than duplicates. */
export function adhocId(profileId, url) {
  const key = String(url).split('#')[0];
  return 'adhoc:' + crypto.createHash('sha1').update(`${profileId}|${key}`).digest('hex').slice(0, 16);
}

/**
 * Persist an extracted posting as a normal job row.
 * Uses connector 'adhoc' so it is visible everywhere but never re-scanned.
 */
export async function saveAdhocJob(profileId, url, fields) {
  const id = adhocId(profileId, url);
  const ext = String(url).split('#')[0];
  const existing = await get('SELECT id FROM jobs WHERE id = ?', [id]);

  if (existing) {
    await run(
      `UPDATE jobs SET title=?, company=?, location=?, url=?, salary=?, posted_at=?, description=? WHERE id=?`,
      [fields.title, fields.company, fields.location, url, fields.salary, fields.posted_at, fields.description, id]
    );
  } else {
    await run(
      `INSERT INTO jobs (id, profile_id, connector, external_id, title, company, location, url, salary, posted_at, description, raw_json, status, discovered_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, profileId, 'adhoc', ext,
        fields.title, fields.company, fields.location, url,
        fields.salary, fields.posted_at, fields.description,
        JSON.stringify({ source: 'pasted-link' }), 'in_progress', Date.now(),
      ]
    );
  }
  return await get('SELECT * FROM jobs WHERE id = ?', [id]);
}
