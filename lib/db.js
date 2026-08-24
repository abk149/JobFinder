// Dual-driver storage: TimescaleDB (Postgres) if TIMESCALE_URL is set, else local SQLite.
// Schema is identical-ish; we keep a thin facade so route handlers don't care which is in use.

import path from 'node:path';
import fs from 'node:fs';

const useTimescale = !!process.env.TIMESCALE_URL;

let sqlite = null;
let pgPool = null;

function getSqlite() {
  if (sqlite) return sqlite;
  const Database = require('better-sqlite3');
  const dataDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  sqlite = new Database(path.join(dataDir, 'jobfinder.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      resume_path TEXT,
      keywords TEXT,
      locations TEXT,
      filters TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connector_sessions (
      profile_id TEXT NOT NULL,
      connector TEXT NOT NULL,
      status TEXT NOT NULL,
      last_login_at INTEGER,
      PRIMARY KEY (profile_id, connector)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      connector TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT,
      company TEXT,
      location TEXT,
      url TEXT,
      salary TEXT,
      posted_at TEXT,
      description TEXT,
      raw_json TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      discovered_at INTEGER NOT NULL,
      applied_at INTEGER,
      UNIQUE(profile_id, connector, external_id)
    );
    CREATE INDEX IF NOT EXISTS jobs_profile_status ON jobs(profile_id, status);
    CREATE TABLE IF NOT EXISTS scan_runs (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      connector TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      found INTEGER DEFAULT 0,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS answers (
      profile_id TEXT NOT NULL,
      field_key TEXT NOT NULL,
      label TEXT,
      value TEXT,
      type TEXT,
      last_seen INTEGER NOT NULL,
      hit_count INTEGER DEFAULT 1,
      embedding TEXT,
      PRIMARY KEY (profile_id, field_key)
    );
    CREATE INDEX IF NOT EXISTS answers_profile ON answers(profile_id);

    -- ── Interview-prep subsystem ──────────────────────────────────────────
    -- prep_sources: raw collected material (job descriptions, forum threads,
    --   image transcriptions). Never shown to the user directly; it's the input
    --   the synthesizer reads.
    CREATE TABLE IF NOT EXISTS prep_sources (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT,
      url TEXT,
      content TEXT,
      meta TEXT,
      collected_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS prep_sources_profile ON prep_sources(profile_id, collected_at);

    -- prep_notes: SYNTHESIZED study material. This is what the user reads.
    CREATE TABLE IF NOT EXISTS prep_notes (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT,
      body TEXT,
      source_ids TEXT,
      created_at INTEGER NOT NULL,
      day TEXT,
      evidence TEXT,        -- verbatim JD sentence that put this skill on the list
      demand INTEGER,       -- how many of the user's saved jobs demand this skill
      sources_json TEXT     -- {references:[{n,kind,title,url}], jobs:[...]}
    );
    CREATE INDEX IF NOT EXISTS prep_notes_profile ON prep_notes(profile_id, created_at);

    -- prep_chunks: embedded slices of prep_notes, powering the Q&A bot. Kept
    --   separate from the answers table so study prose never leaks into form fill.
    CREATE TABLE IF NOT EXISTS prep_chunks (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      note_id TEXT NOT NULL,
      topic TEXT,
      text TEXT,
      embedding TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS prep_chunks_profile ON prep_chunks(profile_id);
    CREATE INDEX IF NOT EXISTS prep_chunks_note ON prep_chunks(note_id);

    -- cv_variants: several CVs per profile (backend / AI / leadership …). The best
    --   match for each posting is auto-selected at apply time.
    CREATE TABLE IF NOT EXISTS cv_variants (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      label TEXT NOT NULL,
      filename TEXT,
      path TEXT,
      cv_text TEXT,
      is_default INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cv_variants_profile ON cv_variants(profile_id);

    -- contacts: hiring addresses PUBLISHED IN job ads ("send your CV to ..."), kept as
    -- an outreach directory. Only ever populated from text we already fetched for the
    -- posting itself — nothing is crawled or guessed to build this.
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,            -- profile + lowercased email
      profile_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      designation TEXT,
      company TEXT,
      domain TEXT,
      kind TEXT,                      -- recruiting | personal | unknown
      source_job_id TEXT,
      source_connector TEXT,
      source_url TEXT,
      context TEXT,                   -- the sentence it appeared in
      times_seen INTEGER DEFAULT 1,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      status TEXT DEFAULT 'new',      -- new | contacted | replied | ignored
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS contacts_profile ON contacts(profile_id, last_seen);
    CREATE UNIQUE INDEX IF NOT EXISTS contacts_unique ON contacts(profile_id, email);

    -- emails: job-related messages pulled from a connected mailbox. Only messages
    -- matching the search query are ever fetched; the body is stored so the pipeline
    -- parser and the UI can work offline afterwards.
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,              -- provider message id
      profile_id TEXT NOT NULL,
      thread_id TEXT,
      from_addr TEXT,
      from_name TEXT,
      subject TEXT,
      snippet TEXT,
      body TEXT,
      received_at INTEGER,
      job_id TEXT,                      -- matched job, when we could tell
      match_confidence REAL,
      category TEXT,                    -- rejection | interview | offer | info_request | other
      action_required INTEGER DEFAULT 0,
      summary TEXT,                     -- what it says, in one line
      asks TEXT,                        -- JSON array: what HR wants from you
      suggested_status TEXT,
      handled INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS emails_profile ON emails(profile_id, received_at);
    CREATE INDEX IF NOT EXISTS emails_job ON emails(job_id);

    -- prep_terms: cached "is this a real technology?" verdicts from Stack Overflow
    --   tags + Wikipedia. Global (not per-profile) since the answer doesn't vary.
    CREATE TABLE IF NOT EXISTS prep_terms (
      term TEXT PRIMARY KEY,
      is_tech INTEGER NOT NULL,
      reason TEXT,
      description TEXT,
      docs_hint TEXT,
      checked_at INTEGER NOT NULL
    );
  `);
  // Best-effort migrations for existing dbs.
  try { sqlite.exec('ALTER TABLE answers ADD COLUMN embedding TEXT'); } catch { /* already present */ }
  // Review queue: newly captured answers wait for approval before autofill or the LLM
  // may use them. The column defaults to 'approved' so answers that already existed
  // (and were reviewed by hand) keep working — only new captures arrive as 'pending'.
  try { sqlite.exec("ALTER TABLE answers ADD COLUMN status TEXT DEFAULT 'approved'"); } catch { /* already present */ }
  try { sqlite.exec('ALTER TABLE answers ADD COLUMN reviewed_at INTEGER'); } catch { /* already present */ }
  try { sqlite.exec('ALTER TABLE answers ADD COLUMN source TEXT'); } catch { /* already present */ }
  // Cover letter: a base template on the profile, plus the tailored one we generate
  // per job so it can be reused on the next form without paying for the LLM again.
  try { sqlite.exec('ALTER TABLE profiles ADD COLUMN cover_letter TEXT'); } catch { /* already present */ }
  try { sqlite.exec('ALTER TABLE jobs ADD COLUMN cover_letter TEXT'); } catch { /* already present */ }
  // prep_notes gained evidence/demand/sources_json when prep became evidence-driven.
  for (const col of ['evidence TEXT', 'demand INTEGER', 'sources_json TEXT']) {
    try { sqlite.exec(`ALTER TABLE prep_notes ADD COLUMN ${col}`); } catch { /* already present */ }
  }
  // jobs gained pipeline-tracking, fit-scoring and cross-connector dedup columns.
  //   canonical_key — same role from different boards collapses to one entry
  //   fit_score/fit_json — cached triage score + its explanation
  //   follow_up_at/notes/contact — application pipeline management
  for (const col of [
    'canonical_key TEXT', 'fit_score INTEGER', 'fit_json TEXT',
    'follow_up_at INTEGER', 'notes TEXT', 'contact TEXT', 'status_changed_at INTEGER',
  ]) {
    try { sqlite.exec(`ALTER TABLE jobs ADD COLUMN ${col}`); } catch { /* already present */ }
  }
  // Auto-apply.
  //   answers.options   — the exact choices a dropdown accepts, so your typed answer
  //                       can be mapped onto one instead of silently setting nothing
  //   answers.asked_by  — which job first asked, so a parked question has context
  //   jobs.auto_apply_* — per-job outcome, kept separate from `status` because
  //                       "we could not answer Q3" is not a pipeline stage
  for (const col of ['options TEXT', 'asked_by TEXT', 'asked_at INTEGER']) {
    try { sqlite.exec(`ALTER TABLE answers ADD COLUMN ${col}`); } catch { /* already present */ }
  }
  //   jobs.apply_kind            — 'internal' (applies on the board) or 'external'
  //                                 (redirects to the employer). Known at SCAN time for
  //                                 Naukri, so external jobs never enter a batch at all.
  //   jobs.auto_apply_attempts   — how many times auto-apply has tried this posting.
  //                                 Two failures and it is set aside, so one broken form
  //                                 cannot occupy a slot in every future run.
  //   jobs.auto_apply_blocked_on — the answer keys this job is waiting on, so it is not
  //                                 retried until you have actually answered them.
  for (const col of [
    'auto_apply_state TEXT', 'auto_apply_note TEXT', 'auto_applied_at INTEGER',
    'apply_kind TEXT', 'auto_apply_attempts INTEGER DEFAULT 0', 'auto_apply_blocked_on TEXT',
  ]) {
    try { sqlite.exec(`ALTER TABLE jobs ADD COLUMN ${col}`); } catch { /* already present */ }
  }
  // Repair rows left half-answered by an earlier auto-apply bug: they hold a real
  // value but sit at 'needs_input', so retrieval ignores them while the bank shows them
  // as answered. A value you typed is an answer — restore it.
  try {
    sqlite.exec("UPDATE answers SET status = 'approved' WHERE status = 'needs_input' AND COALESCE(value, '') <> ''");
  } catch { /* column may not exist yet on a fresh db */ }
  try { sqlite.exec('CREATE INDEX IF NOT EXISTS jobs_canonical ON jobs(profile_id, canonical_key)'); } catch { /* ignore */ }
  try { sqlite.exec('CREATE INDEX IF NOT EXISTS jobs_followup ON jobs(profile_id, follow_up_at)'); } catch { /* ignore */ }

  // One-shot repair of double/triple-stringified profiles.filters values left over
  // from when the PUT handler re-stringified an already-string body. Idempotent:
  // re-parses until we get an object or fail safely, then writes back canonical JSON.
  try {
    const rows = sqlite.prepare('SELECT id, filters FROM profiles').all();
    const fix = sqlite.prepare('UPDATE profiles SET filters = ? WHERE id = ?');
    for (const r of rows) {
      let v = r.filters;
      if (v == null || typeof v === 'object') continue;
      let original = v;
      let parsed = v;
      for (let i = 0; i < 3 && typeof parsed === 'string'; i++) {
        try { parsed = JSON.parse(parsed); } catch { parsed = null; break; }
      }
      const canonical = parsed && typeof parsed === 'object' ? JSON.stringify(parsed) : '{}';
      if (canonical !== original) fix.run(canonical, r.id);
    }
  } catch (e) {
    console.warn('[db] filters repair skipped:', e?.message || e);
  }
  return sqlite;
}

let pgReady = null;   // promise that resolves once schema init (+ repair) has run

function getPg() {
  if (pgReady) return pgReady;
  const pg = require('pg');
  const { Pool } = pg;

  // node-postgres returns BIGINT (int8, OID 20) and NUMERIC as STRINGS by default to
  // avoid precision loss. SQLite returns them as JS numbers. That mismatch is the #1
  // cause of "works on SQLite, breaks on Timescale" bugs — timestamps come back as
  // "1717000000000" and date math / JSON comparisons silently misbehave. Our BIGINT
  // values (epoch millis, counts) are all well within Number.MAX_SAFE_INTEGER, so parse
  // them as numbers to match the SQLite backend exactly.
  pg.types.setTypeParser(20, (v) => (v == null ? null : Number(v)));   // int8 / BIGINT
  pg.types.setTypeParser(1700, (v) => (v == null ? null : Number(v))); // numeric

  pgPool = new Pool({ connectionString: process.env.TIMESCALE_URL });

  pgReady = (async () => {
    await pgPool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT,
      resume_path TEXT, keywords TEXT, locations TEXT, filters TEXT,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connector_sessions (
      profile_id TEXT NOT NULL, connector TEXT NOT NULL,
      status TEXT NOT NULL, last_login_at BIGINT,
      PRIMARY KEY (profile_id, connector)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, connector TEXT NOT NULL,
      external_id TEXT NOT NULL, title TEXT, company TEXT, location TEXT,
      url TEXT, salary TEXT, posted_at TEXT, description TEXT, raw_json TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      discovered_at BIGINT NOT NULL, applied_at BIGINT,
      UNIQUE(profile_id, connector, external_id)
    );
    CREATE INDEX IF NOT EXISTS jobs_profile_status ON jobs(profile_id, status);
    CREATE TABLE IF NOT EXISTS scan_runs (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, connector TEXT NOT NULL,
      started_at BIGINT NOT NULL, finished_at BIGINT, found INT DEFAULT 0, error TEXT
    );
    CREATE TABLE IF NOT EXISTS answers (
      profile_id TEXT NOT NULL, field_key TEXT NOT NULL, label TEXT, value TEXT, type TEXT,
      last_seen BIGINT NOT NULL, hit_count INT DEFAULT 1, embedding TEXT,
      PRIMARY KEY (profile_id, field_key)
    );
    CREATE INDEX IF NOT EXISTS answers_profile ON answers(profile_id);
    ALTER TABLE answers ADD COLUMN IF NOT EXISTS embedding TEXT;
    ALTER TABLE answers ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'approved';
    ALTER TABLE answers ADD COLUMN IF NOT EXISTS reviewed_at BIGINT;
    ALTER TABLE answers ADD COLUMN IF NOT EXISTS source TEXT;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS cover_letter TEXT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cover_letter TEXT;
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, email TEXT NOT NULL,
      name TEXT, designation TEXT, company TEXT, domain TEXT, kind TEXT,
      source_job_id TEXT, source_connector TEXT, source_url TEXT, context TEXT,
      times_seen INT DEFAULT 1, first_seen BIGINT NOT NULL, last_seen BIGINT NOT NULL,
      status TEXT DEFAULT 'new', notes TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS contacts_unique ON contacts(profile_id, email);
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, thread_id TEXT,
      from_addr TEXT, from_name TEXT, subject TEXT, snippet TEXT, body TEXT,
      received_at BIGINT, job_id TEXT, match_confidence REAL, category TEXT,
      action_required INT DEFAULT 0, summary TEXT, asks TEXT, suggested_status TEXT,
      handled INT DEFAULT 0, created_at BIGINT NOT NULL
    );

    -- ── Interview-prep subsystem (mirrors the SQLite schema above) ────────
    CREATE TABLE IF NOT EXISTS prep_sources (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT, url TEXT, content TEXT, meta TEXT, collected_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS prep_sources_profile ON prep_sources(profile_id, collected_at);
    CREATE TABLE IF NOT EXISTS prep_notes (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, topic TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT, body TEXT, source_ids TEXT, created_at BIGINT NOT NULL, day TEXT
    );
    ALTER TABLE prep_notes ADD COLUMN IF NOT EXISTS evidence TEXT;
    ALTER TABLE prep_notes ADD COLUMN IF NOT EXISTS demand INT;
    ALTER TABLE prep_notes ADD COLUMN IF NOT EXISTS sources_json TEXT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS canonical_key TEXT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS fit_score INT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS fit_json TEXT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS follow_up_at BIGINT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS contact TEXT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS status_changed_at BIGINT;
    ALTER TABLE answers ADD COLUMN IF NOT EXISTS options TEXT;
    ALTER TABLE answers ADD COLUMN IF NOT EXISTS asked_by TEXT;
    ALTER TABLE answers ADD COLUMN IF NOT EXISTS asked_at BIGINT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS auto_apply_state TEXT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS auto_apply_note TEXT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS auto_applied_at BIGINT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS apply_kind TEXT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS auto_apply_attempts INT DEFAULT 0;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS auto_apply_blocked_on TEXT;
    CREATE INDEX IF NOT EXISTS jobs_canonical ON jobs(profile_id, canonical_key);
    CREATE INDEX IF NOT EXISTS jobs_followup ON jobs(profile_id, follow_up_at);
    CREATE INDEX IF NOT EXISTS prep_notes_profile ON prep_notes(profile_id, created_at);
    CREATE TABLE IF NOT EXISTS prep_chunks (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, note_id TEXT NOT NULL,
      topic TEXT, text TEXT, embedding TEXT, created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS prep_chunks_profile ON prep_chunks(profile_id);
    CREATE INDEX IF NOT EXISTS prep_chunks_note ON prep_chunks(note_id);
    CREATE TABLE IF NOT EXISTS prep_terms (
      term TEXT PRIMARY KEY, is_tech INT NOT NULL, reason TEXT,
      description TEXT, docs_hint TEXT, checked_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cv_variants (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, label TEXT NOT NULL,
      filename TEXT, path TEXT, cv_text TEXT, is_default INT DEFAULT 0,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cv_variants_profile ON cv_variants(profile_id);
  `);

    // Same double/triple-stringified profiles.filters repair we run for SQLite — must
    // also run here, otherwise legacy Timescale rows keep their bad encoding and
    // parseFilters has to peel them on every read.
    try {
      const { rows } = await pgPool.query('SELECT id, filters FROM profiles');
      for (const r of rows) {
        let v = r.filters;
        if (v == null || typeof v === 'object') continue; // already an object (JSONB col) — fine
        let parsed = v;
        for (let i = 0; i < 3 && typeof parsed === 'string'; i++) {
          try { parsed = JSON.parse(parsed); } catch { parsed = null; break; }
        }
        const canonical = parsed && typeof parsed === 'object' ? JSON.stringify(parsed) : '{}';
        if (canonical !== v) await pgPool.query('UPDATE profiles SET filters = $1 WHERE id = $2', [canonical, r.id]);
      }
    } catch (e) {
      console.warn('[db] PG filters repair skipped:', e?.message || e);
    }

    return pgPool;
  })().catch((e) => {
    console.error('PG schema init failed:', e);
    pgReady = null; // allow a retry on the next call instead of caching the failure
    throw e;
  });

  return pgReady;
}

// Tiny query facade. SQLite uses ? placeholders; PG uses $1,$2…
// Pass SQL with ? and we translate for PG.
function translate(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// If a column that we store as TEXT-JSON comes back already parsed (because an older
// Timescale schema declared it JSONB/JSON), re-stringify it so every downstream
// consumer can treat it as a string uniformly — matching the SQLite backend.
const JSON_TEXT_COLUMNS = ['filters', 'raw_json', 'embedding'];
function normalizeRow(row) {
  if (!row) return row;
  for (const col of JSON_TEXT_COLUMNS) {
    if (col in row && row[col] != null && typeof row[col] === 'object') {
      row[col] = JSON.stringify(row[col]);
    }
  }
  return row;
}

export async function all(sql, params = []) {
  if (useTimescale) {
    const pool = await getPg();
    const r = await pool.query(translate(sql), params);
    return r.rows.map(normalizeRow);
  }
  return getSqlite().prepare(sql).all(...params);
}

export async function get(sql, params = []) {
  if (useTimescale) {
    const pool = await getPg();
    const r = await pool.query(translate(sql), params);
    return normalizeRow(r.rows[0]) ?? null;
  }
  return getSqlite().prepare(sql).get(...params) ?? null;
}

/**
 * Execute a write. Returns { changes } — the number of rows actually affected.
 *
 * Callers need this to tell "inserted" from "skipped by ON CONFLICT DO NOTHING".
 * Without it the scan counted every attempted insert as a new job, so a source
 * returning 50 already-known jobs and a source returning nothing both reported
 * the same thing.
 */
export async function run(sql, params = []) {
  if (useTimescale) {
    const pool = await getPg();
    const r = await pool.query(translate(sql), params);
    return { changes: r.rowCount ?? 0 };
  }
  const info = getSqlite().prepare(sql).run(...params);
  return { changes: info?.changes ?? 0 };
}

export function backendName() {
  return useTimescale ? 'timescale' : 'sqlite';
}
