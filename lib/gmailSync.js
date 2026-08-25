// Pull job-related mail, match it to your applications, and say what it asks for.
//
// Every message is processed the same way the paste-in path already does it — the
// difference is only how the text arrives. That reuse matters: there is one definition
// of "which job is this about" and one of "what does this mean", not two that drift.
//
// Cost control: classification is an LLM call per message, so a sync only classifies
// messages it has not seen before, and stores the verdict. Re-syncing is cheap.

import { all, get, run } from './db.js';
import { buildQuery, searchMessages, getMessage, gmailStatus } from './gmail.js';
import { fetchJobMail, mailStatus, noteMailSync } from './imapMail.js';
import { matchJob, classifyEmail } from './inbox.js';
import { lcmd, linfo, lok, lwarn } from './logger.js';
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths.js';

const TOKEN_FILE = dataPath('gmail.json');

function noteSync(count) {
  try {
    const s = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    s.last_sync = Date.now();
    s.last_count = count;
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  } catch { /* non-fatal */ }
}

/** Companies you have actually applied to — the personalised half of the search. */
async function appliedCompanies(profileId) {
  const rows = await all(
    `SELECT DISTINCT company FROM jobs
      WHERE profile_id = ? AND company <> ''
        AND status IN ('in_progress','applied','screening','interview','offer')`,
    [profileId]
  );
  return rows.map((r) => r.company).filter(Boolean);
}

/**
 * Fetch, match and classify. Returns a summary for the UI.
 *
 * @param {object} opts.days       how far back to look
 * @param {number} opts.max        hard cap on messages fetched
 * @param {boolean} opts.classify  run the LLM (off = fetch + match only, much faster)
 */
export async function syncGmail(profile, { days = 45, max = 40, classify = true } = {}) {
  const pid = profile.id;
  // Either transport is fine — the matching and classification below are identical,
  // which is the point of routing both through here rather than duplicating them.
  const oauth = gmailStatus();
  const imap = mailStatus();
  const via = oauth.connected ? 'oauth' : imap.connected ? 'imap' : null;
  if (!via) throw new Error('No mailbox connected.');
  const st = via === 'oauth' ? oauth : imap;

  lcmd(pid, `▶ Checking ${st.email || st.user || 'your mailbox'} for job updates (last ${days} days, via ${via.toUpperCase()})…`);

  const companies = await appliedCompanies(pid);
  const extraTerms = [];
  try {
    const f = JSON.parse(profile.filters || '{}');
    for (const k of (f.keywords || []).slice(0, 5)) extraTerms.push(k);
  } catch { /* ignore */ }

  linfo(pid, `  Searching ${companies.length} applied compan${companies.length === 1 ? 'y' : 'ies'} + recruiting terms.`);

  // OAuth returns ids to fetch lazily; IMAP hands back whole messages already. Normalise
  // to "a list of things we can turn into a message" so the loop below is shared.
  let ids = [];
  let prefetched = null;
  const query = via === 'oauth' ? buildQuery({ companies, days, extraTerms }) : '(imap)';
  try {
    if (via === 'oauth') {
      ids = await searchMessages(query, max);
    } else {
      prefetched = await fetchJobMail({ days, max, companies });
      ids = prefetched.map((m) => m.id);
    }
  } catch (e) {
    lwarn(pid, `  ✗ Mail search failed: ${String(e?.message || e).slice(0, 160)}`);
    throw e;
  }
  linfo(pid, `  ${ids.length} message(s) match. Processing the ones we haven't seen…`);

  let added = 0, skipped = 0, matched = 0, needAction = 0;
  const samples = [];

  for (const id of ids) {
    const seen = await get('SELECT id FROM emails WHERE id = ?', [id]);
    if (seen) { skipped++; continue; }

    let msg;
    if (prefetched) {
      msg = prefetched.find((m) => m.id === id);
      if (!msg) continue;
    } else {
      try { msg = await getMessage(id); } catch { continue; }
    }

    // Your own outgoing mail is not an update about you.
    if (profile.email && msg.from_addr === String(profile.email).toLowerCase()) { skipped++; continue; }

    const text = `${msg.subject}\n\n${msg.body}`;
    const m = await matchJob(pid, text).catch(() => null);

    let verdict = null;
    if (classify) {
      verdict = await classifyEmail(profile, text).catch(() => null);
    }

    await run(
      `INSERT INTO emails (id, profile_id, thread_id, from_addr, from_name, subject, snippet, body,
                           received_at, job_id, match_confidence, category, action_required,
                           summary, asks, suggested_status, handled, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        msg.id, pid, msg.thread_id, msg.from_addr, msg.from_name, msg.subject,
        msg.snippet, msg.body, msg.received_at,
        m?.job?.id || null, m?.score ?? null,
        verdict?.stage || null,
        verdict?.action_required ? 1 : 0,
        verdict?.summary || '',
        JSON.stringify(verdict?.asks || []),
        verdict?.stage && verdict.stage !== 'unknown' ? verdict.stage : null,
        0, Date.now(),
      ]
    );
    added++;
    if (m?.job) matched++;
    if (verdict?.action_required) needAction++;
    if (samples.length < 4) {
      samples.push({
        subject: msg.subject,
        from: msg.from_name || msg.from_addr,
        job: m?.job ? `${m.job.title} @ ${m.job.company}` : null,
        stage: verdict?.stage || null,
        asks: verdict?.asks || [],
      });
    }
  }

  if (via === 'oauth') noteSync(added); else noteMailSync(added);
  lok(pid, `  ✓ ${added} new, ${skipped} already seen · ${matched} matched to a saved job · ${needAction} need a reply`);
  for (const s of samples) {
    linfo(pid, `    • ${String(s.subject).slice(0, 60)}${s.job ? `  → ${s.job}` : ''}${s.asks?.length ? `  asks: ${s.asks.join('; ').slice(0, 70)}` : ''}`);
  }

  return { scanned: ids.length, added, skipped, matched, needAction, samples, query };
}

/** Everything we've captured, newest first, with the matched job joined on. */
export async function listEmails(profileId, { limit = 60, onlyActionable = false } = {}) {
  const rows = await all(
    `SELECT e.*, j.title AS job_title, j.company AS job_company, j.status AS job_status
       FROM emails e LEFT JOIN jobs j ON j.id = e.job_id
      WHERE e.profile_id = ?${onlyActionable ? ' AND e.action_required = 1 AND e.handled = 0' : ''}
      ORDER BY e.received_at DESC LIMIT ?`,
    [profileId, limit]
  );
  return rows.map((r) => {
    let asks = [];
    try { asks = JSON.parse(r.asks || '[]'); } catch { /* ignore */ }
    return { ...r, asks, body: undefined, bodyPreview: String(r.body || '').slice(0, 1200) };
  });
}

export async function markHandled(profileId, id, handled = true) {
  await run('UPDATE emails SET handled = ? WHERE profile_id = ? AND id = ?', [handled ? 1 : 0, profileId, id]);
}

/** Re-run matching + classification for one message already stored. */
export async function reanalyse(profile, id) {
  const e = await get('SELECT * FROM emails WHERE profile_id = ? AND id = ?', [profile.id, id]);
  if (!e) throw new Error('email not found');
  const text = `${e.subject}\n\n${e.body}`;
  const m = await matchJob(profile.id, text).catch(() => null);
  const v = await classifyEmail(profile, text).catch(() => null);
  await run(
    `UPDATE emails SET job_id=?, match_confidence=?, category=?, action_required=?, summary=?, asks=?, suggested_status=?
      WHERE profile_id=? AND id=?`,
    [
      m?.job?.id || null, m?.score ?? null, v?.stage || null,
      v?.action_required ? 1 : 0, v?.summary || '', JSON.stringify(v?.asks || []),
      v?.stage && v.stage !== 'unknown' ? v.stage : null,
      profile.id, id,
    ]
  );
  return await get('SELECT * FROM emails WHERE profile_id = ? AND id = ?', [profile.id, id]);
}
