// Hiring-contact directory, built from addresses that job ads publish themselves.
//
// SCOPE, deliberately narrow:
//   Only text we ALREADY fetched for a posting is read — the job description. Nothing
//   is crawled to find addresses, and no address is ever guessed from a name-and-domain
//   pattern. An address gets in here because the employer printed it in their own ad
//   next to "send your CV to", which is an invitation to write to them.
//
// Measured on 1,232 saved postings: 2.4% contain an address, and 25 of the 29 come from
// Hacker News "Who is hiring" threads, where a contact line is the convention. So this
// is a slow-filling, high-quality list rather than a bulk one — which is the right shape
// for outreach anyway.

import crypto from 'node:crypto';
import { all, get, run } from './db.js';

// Deliberately conservative: a trailing-dot or bracket capture creates addresses that
// bounce, and a bounced cold email is worse than a missing one.
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+/g;

// Addresses that exist in ad copy but are not people you can write to.
const JUNK_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|postmaster|abuse|webmaster|privacy|legal|dmca|unsubscribe|bounce|mailer-daemon|notifications?|alerts?|support@sentry)/i;
const JUNK_DOMAIN = /(example|test|domain|yourcompany|company)\.(com|org|net)$|\.(png|jpg|jpeg|gif|webp|svg|css|js)$|sentry\.io$|wixpress\.com$|\.local$/i;
const ROLE_LOCAL = /^(careers?|jobs?|hiring|recruit(ing|ment)?|hr|talent|apply|applications?|cv|resumes?|people(ops)?|joinus|work|employment)$/i;

// Not everyone who prints an address in a hiring context is hiring.
//
// Two kinds showed up in real data and both are useless — or worse, rude — to cold-mail:
//   • JOB SEEKERS. Hacker News runs "Who wants to be hired?" alongside "Who is hiring?",
//     and those posts carry the same shape: an address plus "Location: … Remote: …
//     Technologies: …". Mailing them about a role you want is backwards.
//   • BENCH-SALES / STAFFING VENDORS pitching consultants ("available immediately for
//     C2C", "bench consultants"). They are selling, not recruiting.
// NOTE: no trailing \b on this alternation. An earlier version ended with one, which
// silently broke `resume:\s*http` — the character after "http" is "s", not a boundary,
// so every "Resume: https://…" line slipped through and seeker posts kept landing here.
const SEEKER_CONTEXT = new RegExp([
  'willing to relocate',
  'seeking (a )?(new )?(role|position|opportunit)',
  'open to work',
  'looking for (a )?(new )?(role|position|opportunit)',
  'r[\u00e9e]sum[\u00e9e]\\s*[/:]',        // "Résumé/CV:" or "Resume:" — a seeker sharing theirs
  'resume\\s*:\\s*https?',
  'available immediately for',
  'bench (consultants?|sales)',
  'c2c (opportunit|requirement)',
  'hotlist',
].join('|'), 'i');
const SEEKER_SHAPE = /location:\s*.{0,60}\bremote:\s*/i;

// "Contact: Priya Sharma, Talent Acquisition Manager — priya@x.com"
const TITLE_WORDS = /\b(recruiter|recruiting|talent acquisition|talent partner|hiring manager|head of (people|talent|hr)|hr (manager|lead|head|business partner)|people ops|founder|co-?founder|ceo|cto|coo|vp of [a-z ]+|director of [a-z ]+|engineering manager|team lead)\b/i;

function titleCase(s) {
  return String(s || '').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Is this local part a shared hiring inbox rather than a person?
 *
 * Two shapes defeated a naive equality test on real data:
 *   talent+hn@cwai.co        — a plus-tag, common on Hacker News posts
 *   mdds.recruiting@md.gov   — a role word behind a department prefix
 * So the tag is stripped and every dot-separated part is checked.
 */
function isRoleInbox(local) {
  const base = String(local || '').replace(/\+.*$/, '');
  if (ROLE_LOCAL.test(base)) return true;
  return base.split('.').some((part) => ROLE_LOCAL.test(part));
}

/**
 * Company strings arriving from scrapers carry debris — trailing URLs, leading
 * punctuation, HTML entities, and occasionally a whole "Role: …" line. A directory you
 * intend to mail-merge from cannot have "Join ( https:&#x2F;&#x2F" as a company.
 */
export function cleanCompany(raw) {
  return String(raw || '')
    .replace(/&#x2F;/gi, '/').replace(/&amp;/gi, '&').replace(/&#0?39;/g, "'")
    .replace(/&#x?[0-9a-f]{1,6};?/gi, ' ')          // truncated entities: "&#x2F" with no ;
    .replace(/https?:\S*/gi, ' ')                    // not /\/\// — scraped text truncates it
    .replace(/\bRole:.*$/i, ' ')
    .replace(/[([{<]\s*$/, ' ')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,\-–—(]+$/, '')
    .trim()
    .slice(0, 120);
}

/** Guess a human name from the local part when it plainly looks like one. */
function nameFromLocal(local) {
  const l = String(local || '').replace(/\+.*$/, '');           // drop amays+hn → amays
  if (isRoleInbox(l)) return '';
  if (/^[a-z]+\.[a-z]+$/i.test(l)) return titleCase(l.replace('.', ' '));
  if (/^[a-z]{3,12}$/i.test(l)) return titleCase(l);            // dani, lukasz, tim
  return '';
}

/** The sentence the address sits in — useful context when you write to them. */
function sentenceAround(text, index, len) {
  const start = text.lastIndexOf('.', Math.max(0, index - 1));
  const end = text.indexOf('.', index + len);
  return text
    .slice(start === -1 ? Math.max(0, index - 160) : start + 1, end === -1 ? Math.min(text.length, index + len + 120) : end + 1)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * Pull publishable contacts out of one job's text.
 * @returns {Array<{email,name,designation,kind,domain,context}>}
 */
export function extractContacts(text, { company = '' } = {}) {
  const src = String(text || '');
  if (!src.includes('@')) return [];

  const found = new Map();
  let m;
  EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(src))) {
    const raw = m[0].replace(/[.,;:)\]]+$/, '');
    const email = raw.toLowerCase();
    const [local, domain] = email.split('@');
    if (!local || !domain) continue;
    if (JUNK_LOCAL.test(local) || JUNK_DOMAIN.test(domain)) continue;
    if (email.length > 120) continue;
    if (found.has(email)) continue;

    const context = sentenceAround(src, m.index, raw.length);

    // Judge on the WIDER window, not the sentence: a seeker post states "Location: …
    // Remote: …" a line or two away from the address, not in the same sentence.
    const window = src.slice(Math.max(0, m.index - 600), m.index + 600);
    if (SEEKER_CONTEXT.test(window) || SEEKER_SHAPE.test(window)) continue;
    const titleHit = context.match(TITLE_WORDS);

    // A name stated right before the address beats one guessed from the local part —
    // but only for a personal address. A shared inbox has no person, and the capitalised
    // word before it is usually just the start of the sentence ("To apply: careers@…",
    // which produced the name "To").
    const isRole = isRoleInbox(local);
    const before = src.slice(Math.max(0, m.index - 90), m.index);
    const stated = isRole ? null : before.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s*[,–—-]?\s*(?:at\s+)?[^.]{0,40}$/);
    const SENTENCE_STARTERS = /^(To|Send|Email|Contact|Apply|Please|Reach|Write|Mail|Drop|Our|The|We|If|For|Interested)$/;
    const statedName = stated && !SENTENCE_STARTERS.test(stated[1]) ? stated[1] : '';

    found.set(email, {
      email,
      domain,
      name: isRole ? '' : (nameFromLocal(local) || statedName),
      designation: titleHit ? titleCase(titleHit[0]) : (isRole ? 'Recruiting inbox' : ''),
      kind: isRole ? 'recruiting' : 'personal',
      context,
      company: cleanCompany(company),
    });
  }
  return [...found.values()];
}

function contactId(profileId, email) {
  return crypto.createHash('sha1').update(`${profileId}|${email.toLowerCase()}`).digest('hex').slice(0, 20);
}

/**
 * Store contacts found in one job. Re-seeing an address bumps its counter and fills in
 * any field that was previously blank, rather than overwriting what you may have edited.
 * @returns {Promise<{added:number, updated:number}>}
 */
export async function recordContacts(profileId, job, contacts) {
  let added = 0, updated = 0;
  const now = Date.now();

  for (const c of contacts) {
    const id = contactId(profileId, c.email);
    const existing = await get('SELECT * FROM contacts WHERE id = ?', [id]);
    if (existing) {
      await run(
        `UPDATE contacts SET times_seen = times_seen + 1, last_seen = ?,
           name = COALESCE(NULLIF(name,''), ?), designation = COALESCE(NULLIF(designation,''), ?),
           company = COALESCE(NULLIF(company,''), ?), context = COALESCE(NULLIF(context,''), ?)
         WHERE id = ?`,
        [now, c.name || '', c.designation || '', c.company || '', c.context || '', id]
      );
      updated++;
    } else {
      await run(
        `INSERT INTO contacts (id, profile_id, email, name, designation, company, domain, kind,
                               source_job_id, source_connector, source_url, context,
                               times_seen, first_seen, last_seen, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id, profileId, c.email, c.name || '', c.designation || '', c.company || '',
          c.domain || '', c.kind || 'unknown',
          job?.id || null, job?.connector || null, job?.url || null, c.context || '',
          1, now, now, 'new',
        ]
      );
      added++;
    }
  }
  return { added, updated };
}

/** Convenience used by the scan path and the backfill. */
export async function harvestFromJob(profileId, job) {
  const text = `${job?.title || ''}\n${job?.description || ''}`;
  const found = extractContacts(text, { company: job?.company || '' });
  if (!found.length) return { added: 0, updated: 0, found: 0 };
  const r = await recordContacts(profileId, job, found);
  return { ...r, found: found.length };
}

export async function listContacts(profileId, { status, q, limit = 500 } = {}) {
  const where = ['profile_id = ?'];
  const params = [profileId];
  if (status && status !== 'all') { where.push('status = ?'); params.push(status); }
  const rows = await all(
    `SELECT * FROM contacts WHERE ${where.join(' AND ')} ORDER BY last_seen DESC LIMIT ?`,
    [...params, limit]
  );
  if (!q) return rows;
  const needle = String(q).toLowerCase();
  return rows.filter((r) =>
    [r.email, r.name, r.company, r.designation].some((v) => String(v || '').toLowerCase().includes(needle))
  );
}

export async function updateContact(profileId, email, patch = {}) {
  const id = contactId(profileId, email);
  const fields = [];
  const params = [];
  for (const k of ['name', 'designation', 'company', 'status', 'notes']) {
    if (patch[k] !== undefined) { fields.push(`${k} = ?`); params.push(patch[k]); }
  }
  if (!fields.length) return null;
  await run(`UPDATE contacts SET ${fields.join(', ')} WHERE id = ? AND profile_id = ?`, [...params, id, profileId]);
  return await get('SELECT * FROM contacts WHERE id = ?', [id]);
}

export async function deleteContact(profileId, email) {
  await run('DELETE FROM contacts WHERE id = ? AND profile_id = ?', [contactId(profileId, email), profileId]);
}

/** CSV for a mail-merge tool or a spreadsheet. */
export function toCsv(rows) {
  const cols = ['email', 'name', 'designation', 'company', 'kind', 'status', 'times_seen', 'source_connector', 'source_url', 'context'];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}
