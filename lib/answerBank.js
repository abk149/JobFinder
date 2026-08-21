import { all, get, run } from './db.js';
import { indexAnswer } from './knowledge.js';

// Second line of defence. The observer already filters at the point of capture, but
// it runs inside a hostile page and its result travels through several hops — nothing
// that reaches the bank should be trusted purely because it arrived. A bad row here is
// expensive: it becomes an exact-key match, which outranks every semantic result and
// is therefore never reconsidered.
const JUNK_KEY = /^rec[\s_-]?form|^[\d\s._-]+$|\d{8,}|honeypot|captcha|^(un)?known$/i;
// The job board's own search and filter controls. These sit on the same page as the
// application but describe what you were looking for, not who you are.
const SEARCH_KEY = /^(search|query|keyword|filter|find)\b|^enter\s*(keyword|location)|search\s*by|designation\s*(or\s*)?companies/i;
const TRAP_KEY = /robots?\s*only|do\s*not\s*(enter|fill)|if\s*you.?re\s*human|image\s*text|security\s*code/i;

// Server-side twin of the CANON table in observer.js. The observer must stay a
// self-contained string (it is injected into hostile pages), so the list genuinely
// cannot be shared as a module — instead scripts/check-canon-parity.mjs asserts the
// two agree, so drift fails a check rather than silently splitting the bank in two.
const CANON = [
  [/^(first|given)\s*name/, 'first name'],
  [/^(last|family|sur)\s*name/, 'last name'],
  [/(full|candidate|your)\s*name$|^name$/, 'full name'],
  [/linkedin/, 'linkedin url'],
  [/(github|portfolio|personal\s*website|work\s*link)/, 'portfolio url'],
  [/e-?mail/, 'email'],
  [/(phone|mobile)\s*(number|no)?$|^phone/, 'phone'],
  [/notice\s*period/, 'notice period'],
  [/(current|present)\s*(annual\s*)?(ctc|salary|compensation)/, 'current ctc'],
  [/expected\s*(annual\s*)?(ctc|salary|compensation)/, 'expected ctc'],
  [/(total\s*)?years?\s*of\s*experience|^experience\s*\(?years/, 'years of experience'],
  [/current\s*(company|employer)/, 'current company'],
  [/current\s*(designation|title|role|job\s*title)/, 'current designation'],
  [/(current\s*)?(city|location)$|^city/, 'city'],
  [/(zip|postal)\s*code/, 'zip code'],
  [/^country/, 'country'],
  [/nationality|citizenship/, 'nationality'],
];

export function canonicalKey(key, type) {
  const k = String(key || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, name] of CANON) if (re.test(k)) return name;
  if (type === 'email') return 'email';
  if (type === 'tel') return 'phone';
  return k;
}

export function junkReason(field_key, value, type) {
  const k = String(field_key || '').trim().toLowerCase();
  const v = String(value ?? '').trim();
  if (!k) return 'empty key';
  if (!v) return 'empty value';
  if (JUNK_KEY.test(k)) return 'opaque/internal field id';
  if (SEARCH_KEY.test(k)) return 'job-board search/filter box, not an application field';
  if (TRAP_KEY.test(k)) return 'honeypot or captcha field';
  if (k.length < 2) return 'key too short to be a question';
  if (!/[a-z]/.test(k)) return 'key has no words';
  if (v.length > 5000) return 'value too long';
  // Type/value contradictions — the "linkedin profile = Kolkata" class of corruption.
  if ((type === 'email' || /e-?mail/.test(k)) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return 'not an email';
  if ((type === 'url' || /linkedin|github|portfolio|website/.test(k)) && !/(https?:\/\/|www\.|\.[a-z]{2,}\/)/i.test(v)) return 'not a URL';
  if ((type === 'tel' || /^phone|mobile/.test(k)) && v.replace(/\D/g, '').length < 7) return 'not a phone number';
  if (/(salary|ctc|notice period|years? of experience|zip|postal)/.test(k) && !/\d/.test(v)) return 'expected a number';
  if (k.length > 60 && v.split(/\s+/).length < 3) return 'one-word answer to an essay question';
  // Free-text prompts need a real answer. "cover letter … = <your first name>" is how a
  // mis-targeted write looks after the fact.
  if (/(cover letter|describe|explain|tell us|write about|why do you|how do you|in max)/.test(k)
      && v.split(/\s+/).length < 8) return 'too short for a free-text question';
  // A placeholder is not a question — "Type your answer here" tells us nothing about
  // what was being asked, so the answer can never be matched to a future field.
  if (/^(type|enter|write)\s+(your\s+)?answer|^your\s+answer$|^answer$|^comments?$|^loading$/.test(k)) {
    return 'placeholder, not a real question';
  }
  if (/^country/.test(k) && /^\d+$/.test(v)) return 'country stored as a dialling code';
  // Yes/no questions answered with a paragraph — the classic mis-targeted long draft.
  // ...but only when the question really is yes/no. "Have you worked with APIs, and
  // if so in what context?" opens with a yes/no and then asks for a paragraph.
  const invitesDetail = /(if so|if yes|in what|please (explain|describe|elaborate|specify|share)|why|how|which|what|describe|elaborate|details?)\b/.test(k);
  if (/^(do|does|are|is|have|has|will|would|can|did|any)\s+you\b/.test(k)
      && !invitesDetail && v.split(/\s+/).length > 12) {
    return 'paragraph answering a yes/no question';
  }
  return null;
}

export async function recordAnswer(profileId, { field_key, label, value, type, source }) {
  if (!field_key || value == null) return;
  const bad = junkReason(field_key, value, type);
  if (bad) return { rejected: bad };
  const existing = await get(
    'SELECT field_key, hit_count, value, status FROM answers WHERE profile_id = ? AND field_key = ?',
    [profileId, field_key]
  );
  const changed = !existing || existing.value !== value;

  // A rejection is a decision, not a one-off delete. If you already rejected this
  // exact value, silently drop it rather than re-queueing it for review every time
  // the page is harvested — otherwise you would be rejecting the same row forever.
  if (existing && existing.status === 'rejected' && !changed) {
    return { rejected: 'previously rejected by you' };
  }

  if (existing) {
    // Editing an approved answer sends it back for review — the whole point is that
    // nothing reaches autofill without your say-so, including a changed value.
    const nextStatus = changed ? 'pending' : existing.status || 'approved';
    await run(
      'UPDATE answers SET value = ?, label = ?, type = ?, last_seen = ?, hit_count = hit_count + 1, status = ?, source = COALESCE(?, source) WHERE profile_id = ? AND field_key = ?',
      [value, label || '', type || '', Date.now(), nextStatus, source || null, profileId, field_key]
    );
  } else {
    await run(
      'INSERT INTO answers (profile_id, field_key, label, value, type, last_seen, hit_count, status, source) VALUES (?,?,?,?,?,?,?,?,?)',
      [profileId, field_key, label || '', value, type || '', Date.now(), 1, 'pending', source || 'page']
    );
  }
  // Re-embed if the text content changed. Fire-and-forget — observer shouldn't block on this.
  if (changed) {
    const profile = await get('SELECT id, filters FROM profiles WHERE id = ?', [profileId]);
    if (profile) indexAnswer(profile, { field_key, label, value }).catch(() => {});
  }
  return { status: 'pending' };
}

// Everything in the bank, whatever its review state — for the review UI.
export async function listAnswers(profileId, { status } = {}) {
  if (status) {
    return await all(
      'SELECT * FROM answers WHERE profile_id = ? AND status = ? ORDER BY last_seen DESC',
      [profileId, status]
    );
  }
  return await all(
    'SELECT * FROM answers WHERE profile_id = ? ORDER BY hit_count DESC, last_seen DESC',
    [profileId]
  );
}

export async function countPending(profileId) {
  const r = await get(
    "SELECT COUNT(*) AS n FROM answers WHERE profile_id = ? AND status = 'pending'",
    [profileId]
  );
  return Number(r?.n || 0);
}

// Bulk review. Returns how many rows actually changed.
export async function reviewAnswers(profileId, keys, decision) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('decision must be approved or rejected');
  let n = 0;
  for (const key of keys || []) {
    const r = await run(
      'UPDATE answers SET status = ?, reviewed_at = ? WHERE profile_id = ? AND field_key = ?',
      [decision, Date.now(), profileId, key]
    );
    n += r?.changes || 0;
  }
  return n;
}

export async function reviewAllPending(profileId, decision) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('decision must be approved or rejected');
  const r = await run(
    "UPDATE answers SET status = ?, reviewed_at = ? WHERE profile_id = ? AND status = 'pending'",
    [decision, Date.now(), profileId]
  );
  return r?.changes || 0;
}

// The map autofill fills from. Approved only — this is the gate the whole feature
// exists for, so it is deliberately a separate query rather than a filter on
// listAnswers, which the review UI needs to return everything.
export async function answersAsMap(profileId) {
  const rows = await all(
    "SELECT field_key, value FROM answers WHERE profile_id = ? AND status = 'approved'",
    [profileId]
  );
  const out = {};
  for (const r of rows) out[r.field_key] = r.value;
  return out;
}

export async function deleteAnswer(profileId, fieldKey) {
  await run('DELETE FROM answers WHERE profile_id = ? AND field_key = ?', [profileId, fieldKey]);
}

export async function upsertAnswer(profileId, fieldKey, value, label) {
  const existing = await get(
    'SELECT field_key, value FROM answers WHERE profile_id = ? AND field_key = ?',
    [profileId, fieldKey]
  );
  const changed = !existing || existing.value !== value;
  if (existing) {
    await run(
      "UPDATE answers SET value = ?, label = COALESCE(NULLIF(?, ''), label), last_seen = ?, status = 'approved', reviewed_at = ? WHERE profile_id = ? AND field_key = ?",
      [value, label || '', Date.now(), Date.now(), profileId, fieldKey]
    );
  } else {
    await run(
      'INSERT INTO answers (profile_id, field_key, label, value, type, last_seen, hit_count, status, source) VALUES (?,?,?,?,?,?,?,?,?)',
      [profileId, fieldKey, label || '', value, 'text', Date.now(), 1, 'approved', 'you']
    );
  }
  if (changed) {
    const profile = await get('SELECT id, filters FROM profiles WHERE id = ?', [profileId]);
    if (profile) indexAnswer(profile, { field_key: fieldKey, label, value }).catch(() => {});
  }
}
