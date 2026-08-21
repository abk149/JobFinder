// Hiring-contact directory.
//
//   GET  ?profile_id=…&status=…&q=…        → rows
//   GET  ?profile_id=…&format=csv          → CSV download
//   POST { profile_id, action:'backfill' } → harvest from already-saved job text
//   PATCH { profile_id, email, ...fields } → edit / set status
//   DELETE ?profile_id=…&email=…

import { all } from '../../../lib/db.js';
import { listContacts, updateContact, deleteContact, toCsv, extractContacts, recordContacts } from '../../../lib/contacts.js';
import { readJson, requireFields, withErrorHandling } from '../../../lib/http.js';
import { lcmd, lok } from '../../../lib/logger.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export const GET = withErrorHandling(async (req) => {
  const { searchParams } = new URL(req.url);
  const profile_id = searchParams.get('profile_id');
  requireFields({ profile_id }, ['profile_id']);

  const rows = await listContacts(profile_id, {
    status: searchParams.get('status') || 'all',
    q: searchParams.get('q') || '',
    limit: Number(searchParams.get('limit')) || 500,
  });

  if (searchParams.get('format') === 'csv') {
    return new Response(toCsv(rows), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="jobfinder-contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }
  return Response.json({ ok: true, contacts: rows });
});

export const POST = withErrorHandling(async (req) => {
  const { profile_id, action } = await readJson(req);
  requireFields({ profile_id, action }, ['profile_id', 'action']);

  if (action === 'backfill') {
    lcmd(profile_id, '▶ Harvesting hiring contacts from saved job descriptions…');
    const jobs = await all(
      "SELECT id, connector, url, title, company, description FROM jobs WHERE profile_id = ? AND description LIKE '%@%'",
      [profile_id]
    );
    let added = 0, updated = 0;
    for (const j of jobs) {
      const found = extractContacts(`${j.title || ''}\n${j.description || ''}`, { company: j.company || '' });
      if (!found.length) continue;
      const r = await recordContacts(profile_id, j, found);
      added += r.added; updated += r.updated;
    }
    lok(profile_id, `  ✓ ${added} new contact(s), ${updated} already known (from ${jobs.length} posting(s))`);
    return Response.json({ ok: true, added, updated, scanned: jobs.length });
  }

  return Response.json({ ok: false, error: `unknown action: ${action}` });
});

export const PATCH = withErrorHandling(async (req) => {
  const body = await readJson(req);
  requireFields(body, ['profile_id', 'email']);
  const row = await updateContact(body.profile_id, body.email, body);
  return Response.json({ ok: true, contact: row });
});

export const DELETE = withErrorHandling(async (req) => {
  const { searchParams } = new URL(req.url);
  const profile_id = searchParams.get('profile_id');
  const email = searchParams.get('email');
  requireFields({ profile_id, email }, ['profile_id', 'email']);
  await deleteContact(profile_id, email);
  return Response.json({ ok: true });
});
