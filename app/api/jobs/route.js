import { all, run } from '../../../lib/db.js';
import { readJson, requireFields, withErrorHandling } from '../../../lib/http.js';
import { freshnessOf, isFresh } from '../../../lib/freshness.js';
import { ensureSchedulerStarted } from '../../../lib/schedulerBoot.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  ensureSchedulerStarted();
  const { searchParams } = new URL(req.url);
  const profile_id = searchParams.get('profile_id');
  if (!profile_id) return Response.json({ error: 'profile_id required' }, { status: 400 });
  const status = searchParams.get('status');
  const connector = searchParams.get('connector');
  const q = (searchParams.get('q') || '').trim().toLowerCase();

  const where = ['profile_id = ?'];
  const params = [profile_id];
  if (status) { where.push('status = ?'); params.push(status); }
  if (connector) { where.push('connector = ?'); params.push(connector); }
  // `fresh=N` powers the "Fresh this week" section. It deliberately ignores the
  // status/connector/search filters — the point of that section is a single view of
  // everything new across ALL sources, not a filtered slice.
  const freshDays = Number(searchParams.get('fresh')) || 0;
  if (freshDays > 0) {
    const strict = searchParams.get('strict') === '1';
    // Scan wider than 500: recent rows are not necessarily the most recently
    // discovered, since a source can publish a fresh job we happened to find late.
    const allRows = await all(
      'SELECT * FROM jobs WHERE profile_id = ? ORDER BY discovered_at DESC LIMIT 3000',
      [profile_id]
    );
    const fresh = allRows
      .filter((r) => isFresh(r, freshDays, { strict }))
      .map((r) => ({ ...r, _fresh: freshnessOf(r) }))
      .sort((a, b) => b._fresh.at - a._fresh.at);
    return Response.json({
      jobs: fresh,
      counts: {
        total: fresh.length,
        posted: fresh.filter((r) => r._fresh.basis === 'posted').length,
        seen: fresh.filter((r) => r._fresh.basis === 'seen').length,
      },
    });
  }

  let sql = `SELECT * FROM jobs WHERE ${where.join(' AND ')} ORDER BY discovered_at DESC LIMIT 500`;
  let rows = await all(sql, params);
  if (q) {
    rows = rows.filter((r) =>
      (r.title || '').toLowerCase().includes(q) ||
      (r.company || '').toLowerCase().includes(q) ||
      (r.location || '').toLowerCase().includes(q)
    );
  }
  return Response.json({ jobs: rows });
}

export const PATCH = withErrorHandling(async (req) => {
  const { id, status } = await readJson(req);
  requireFields({ id, status }, ['id', 'status']);
  await run(
    'UPDATE jobs SET status = ?, applied_at = CASE WHEN ? = \'applied\' THEN ? ELSE applied_at END WHERE id = ?',
    [status, status, Date.now(), id]
  );
  return Response.json({ ok: true });
});
