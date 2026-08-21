// Mailbox access via IMAP + an app password.
//
// WHY THIS EXISTS ALONGSIDE OAUTH
// A "Sign in with Google" button that just works requires the *developer* to ship a
// verified OAuth client. Gmail's read scopes are classed by Google as RESTRICTED, and
// verifying an app for those needs an annual third-party security assessment. A
// self-hosted tool cannot clear that bar, so every user would otherwise have to build
// their own Cloud project, register a redirect URI, and add themselves as a test user —
// and even then the refresh token expires every 7 days while the app is "in testing".
//
// So this is the path mail clients have always used: an app-specific password, issued
// and revoked from the Google account page, used over TLS.
//
// TRADE-OFF, stated plainly:
//   • App password  — 2 minutes to set up, never expires, but it IS a credential with
//     full mailbox access, held on this machine.
//   • OAuth          — no password, revocable per-scope, read-only enforced by Google,
//     but 10 minutes of Cloud Console and a 7-day token in testing mode.
// Both are offered. Neither is sent anywhere except to the mail server.
//
// The password is stored in data/mail.json, mode 0600, inside the gitignored data
// directory, and is never returned by any endpoint or written to a log.

import fs from 'node:fs';
import path from 'node:path';
import { linfo, lwarn } from './logger.js';

const STORE = path.join(process.cwd(), 'data', 'mail.json');

const PRESETS = {
  gmail:    { host: 'imap.gmail.com',     port: 993, label: 'Gmail' },
  outlook:  { host: 'outlook.office365.com', port: 993, label: 'Outlook / Microsoft 365' },
  yahoo:    { host: 'imap.mail.yahoo.com', port: 993, label: 'Yahoo' },
  icloud:   { host: 'imap.mail.me.com',   port: 993, label: 'iCloud' },
};

function read() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return {}; }
}
function write(o) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(o, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STORE, 0o600); } catch { /* windows */ }
}

/** Never exposes the password. */
export function mailStatus() {
  const s = read();
  return {
    connected: !!(s.user && s.pass),
    user: s.user || '',
    host: s.host || '',
    provider: s.provider || '',
    lastSync: s.last_sync || 0,
    lastCount: s.last_count ?? null,
  };
}

export function forgetMail() {
  write({});
  return mailStatus();
}

export function noteMailSync(count) {
  const s = read();
  s.last_sync = Date.now();
  s.last_count = count;
  write(s);
}

/**
 * Save and immediately verify. Credentials are only persisted if the server accepts
 * them — storing a password that does not work just moves the failure later.
 */
export async function saveAndVerify({ user, pass, provider = 'gmail', host, port }) {
  const preset = PRESETS[provider] || {};
  const cfg = {
    user: String(user || '').trim(),
    pass: String(pass || '').replace(/\s+/g, ''),   // Google prints app passwords in groups of 4
    host: (host || preset.host || '').trim(),
    port: Number(port || preset.port || 993),
    provider,
  };
  if (!cfg.user || !cfg.pass) throw new Error('Email address and app password are both required.');
  if (!cfg.host) throw new Error('No IMAP host — pick a provider or enter one.');

  const probe = await testConnection(cfg);
  if (!probe.ok) throw new Error(probe.error);

  write({ ...read(), ...cfg });
  return { ...mailStatus(), mailboxes: probe.mailboxes };
}

/** Open a connection, list mailboxes, close. Used to validate credentials. */
export async function testConnection(cfg = read()) {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: cfg.host, port: cfg.port || 993, secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,                       // the default logger prints credentials
    socketTimeout: 20000,
  });
  try {
    await client.connect();
    const boxes = (await client.list()).map((b) => b.path).slice(0, 40);
    await client.logout().catch(() => {});
    return { ok: true, mailboxes: boxes };
  } catch (e) {
    try { await client.close(); } catch { /* ignore */ }
    // imapflow puts the useful part on the error OBJECT, not in .message — a rejected
    // login surfaces as the bare string "Command failed", which tells the user nothing.
    // The real detail is authenticationFailed / serverResponseCode / responseText.
    const msg = [e?.message, e?.responseText, e?.serverResponseCode].filter(Boolean).join(' | ');
    if (e?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(msg)) {
      return {
        ok: false,
        error:
          'The server rejected those credentials. For Gmail this almost always means a normal ' +
          'account password was used — you need a 16-character App Password, and 2-Step ' +
          'Verification must be on for that option to appear.',
      };
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return { ok: false, error: `Cannot reach ${cfg.host}. Check the host name and your connection.` };
    if (/timeout|ETIMEDOUT/i.test(msg)) return { ok: false, error: `${cfg.host} did not respond. Port 993 may be blocked on this network.` };
    return { ok: false, error: msg.slice(0, 200) };
  }
}

/**
 * Search the mailbox and return matching messages.
 *
 * IMAP has no full-text query language like Gmail's, so the narrowing is done in two
 * stages: the server filters by date (cheap, and keeps the fetch small), then we match
 * subject and sender locally against the same vocabulary the Gmail path uses. Only
 * matching messages have their bodies downloaded.
 */
export async function fetchJobMail({ days = 45, max = 60, companies = [], mailbox = 'INBOX' } = {}) {
  const cfg = read();
  if (!cfg.user || !cfg.pass) throw new Error('No mailbox connected.');

  const RECRUIT = [
    'application', 'applied', 'candidate', 'interview', 'recruiter', 'recruitment',
    'hiring', 'shortlist', 'assessment', 'screening', 'offer', 'position', 'role',
    'resume', 'cv', 'availability', 'next steps', 'talent', 'opportunity', 'vacancy',
  ];
  const comps = companies.map((c) => String(c).toLowerCase()).filter((c) => c.length > 2);

  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: cfg.host, port: cfg.port || 993, secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false, socketTimeout: 30000,
  });

  const out = [];
  await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try {
    const since = new Date(Date.now() - days * 86400000);
    const uids = await client.search({ since }, { uid: true });
    // Newest first, and never walk the whole mailbox.
    const recent = uids.slice(-Math.max(max * 6, 200)).reverse();

    for (const uid of recent) {
      if (out.length >= max) break;
      let msg;
      try {
        msg = await client.fetchOne(String(uid), { envelope: true, uid: true }, { uid: true });
      } catch { continue; }
      if (!msg?.envelope) continue;

      const subject = msg.envelope.subject || '';
      const from = msg.envelope.from?.[0] || {};
      const fromAddr = `${from.address || ''}`.toLowerCase();
      const fromName = from.name || '';
      const hay = `${subject} ${fromName} ${fromAddr}`.toLowerCase();

      const looksRelevant =
        RECRUIT.some((w) => hay.includes(w)) || comps.some((c) => hay.includes(c));
      if (!looksRelevant) continue;
      if (fromAddr === String(cfg.user).toLowerCase()) continue;   // your own outgoing mail

      // Only now pay for the body.
      let body = '';
      try {
        const dl = await client.download(String(uid), undefined, { uid: true });
        body = await streamToText(dl.content);
      } catch { /* keep the envelope-only record */ }

      out.push({
        id: `imap:${cfg.user}:${uid}`,
        thread_id: String(msg.envelope.messageId || uid),
        from_addr: fromAddr,
        from_name: fromName,
        subject,
        snippet: body.replace(/\s+/g, ' ').slice(0, 200),
        body: body.slice(0, 20000),
        received_at: msg.envelope.date ? new Date(msg.envelope.date).getTime() : Date.now(),
      });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return out;
}

async function streamToText(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return mimeToText(raw);
}

/**
 * Pull readable text out of a raw RFC822 message.
 * Deliberately small: full MIME parsing is a library's job, but for recruiter mail the
 * text/plain part (or the HTML stripped) is all the classifier needs.
 */
export function mimeToText(raw) {
  const s = String(raw || '');
  const boundaryMatch = s.match(/boundary="?([^";\r\n]+)"?/i);

  const decodePart = (part) => {
    const [rawHead, ...rest] = part.split(/\r?\n\r?\n/);
    const head = rawHead || '';
    let bodyText = rest.join('\n\n');
    if (/quoted-printable/i.test(head)) {
      bodyText = bodyText
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    } else if (/base64/i.test(head)) {
      try { bodyText = Buffer.from(bodyText.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { /* leave as-is */ }
    }
    return { head, bodyText };
  };

  const strip = (html) => html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');

  if (boundaryMatch) {
    const parts = s.split(new RegExp(`--${boundaryMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const decoded = parts.map(decodePart);
    const plain = decoded.find((p) => /text\/plain/i.test(p.head));
    if (plain?.bodyText?.trim()) return plain.bodyText.trim();
    const html = decoded.find((p) => /text\/html/i.test(p.head));
    if (html?.bodyText) return strip(html.bodyText).trim();
  }

  const { head, bodyText } = decodePart(s);
  if (/text\/html/i.test(head)) return strip(bodyText).trim();
  return bodyText.trim();
}

export { PRESETS };
