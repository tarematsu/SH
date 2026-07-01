const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, max-age=60',
  vary: 'accept-encoding',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

function parseDateStart(value, fallback) {
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : fallback;
  return Date.parse(`${text}T00:00:00+09:00`);
}

function todayJstString() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

function encodeCursor(row) {
  if (!row) return null;
  return btoa(`${row.observed_at}:${row.id}`);
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const [timestamp, id] = atob(value).split(':').map(Number);
    return Number.isFinite(timestamp) && Number.isFinite(id) ? { timestamp, id } : null;
  } catch {
    return null;
  }
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);
  const url = new URL(request.url);
  const from = url.searchParams.get('from') || '2024-06-01';
  const to = url.searchParams.get('to') || todayJstString();
  const fromTs = parseDateStart(from, '2024-06-01');
  const requestedToTs = parseDateStart(to, todayJstString()) + 86400000;
  const toTs = Math.min(requestedToTs, fromTs + 31 * 86400000);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 20), 500);
  const cursor = decodeCursor(url.searchParams.get('cursor'));
  let sql = `SELECT id,observed_at,observed_jst,listener_count,total_stream_count,
track_title,artist_name,likes,comment_velocity,host_handle,total_member_count,
source_note,quality_score,quality_flags
FROM sh_legacy_snapshots
WHERE observed_at>=? AND observed_at<?`;
  const binds = [fromTs, toTs];
  if (cursor) {
    sql += ' AND (observed_at>? OR (observed_at=? AND id>?))';
    binds.push(cursor.timestamp, cursor.timestamp, cursor.id);
  }
  sql += ' ORDER BY observed_at ASC,id ASC LIMIT ?';
  binds.push(limit + 1);

  try {
    const result = await env.DB.prepare(sql).bind(...binds).all();
    const allRows = result.results || [];
    const hasMore = allRows.length > limit;
    const rows = hasMore ? allRows.slice(0, limit) : allRows;
    return json({
      ok: true,
      mode: 'raw',
      from,
      to,
      rows,
      has_more: hasMore,
      next_cursor: hasMore ? encodeCursor(rows.at(-1)) : null,
    });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'raw history error' }, 500);
  }
}
