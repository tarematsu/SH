const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, max-age=60',
  vary: 'accept-encoding',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const JST_OFFSET_MS = 9 * 3_600_000;

function validDateText(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const timestamp = Date.parse(`${value}T00:00:00+09:00`);
  if (!Number.isFinite(timestamp)) return false;
  return new Date(timestamp + JST_OFFSET_MS).toISOString().slice(0, 10) === value;
}

function parseDateStart(value) {
  return Date.parse(`${value}T00:00:00+09:00`);
}

function todayJstString() {
  return new Date(Date.now() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function encodeCursor(row) {
  if (!row) return null;
  return btoa(`${row.observed_at}:${row.id}`);
}

export function decodeRawHistoryCursor(value) {
  if (!value) return null;
  try {
    const parts = atob(value).split(':');
    if (parts.length !== 2 || parts.some((part) => part.trim() === '')) return null;
    const [timestamp, id] = parts.map(Number);
    return Number.isSafeInteger(timestamp) && Number.isSafeInteger(id) && timestamp >= 0 && id >= 0
      ? { timestamp, id }
      : null;
  } catch {
    return null;
  }
}

export function rawHistorySql(cursor) {
  let sql = `SELECT f.id,f.observed_at,
  strftime('%Y-%m-%d %H:%M:%S',f.observed_at/1000,'unixepoch','+9 hours') AS observed_jst,
  f.listener_count,
  CASE WHEN f.source_code=1 THEN f.reported_current_stream_count
    ELSE COALESCE(f.reported_current_stream_count,f.reported_total_listens) END AS total_stream_count,
  t.title AS track_title,t.artist AS artist_name,c.track_bite_count AS likes,
  f.comment_count AS comment_velocity,h.current_handle AS host_handle,
  COALESCE((SELECT d.last_total_member_count FROM sh_total_member_daily d
    WHERE d.channel_id=f.channel_id AND d.day_at=(f.observed_at/86400000)*86400000
    ORDER BY d.last_observed_at DESC,d.host_key LIMIT 1),f.total_member_count)
    AS total_member_count,NULL AS source_note,
  f.quality_score_code/100.0 AS quality_score,f.quality_flags,
  f.minute_at,f.source_record_id
FROM sh_minute_facts f
LEFT JOIN sh_minute_fact_context c ON c.fact_id=f.id
LEFT JOIN sh_tracks t ON t.id=c.track_id
LEFT JOIN sh_hosts h ON h.id=c.host_id
WHERE f.source_code IN (3,4) AND f.minute_at>=? AND f.minute_at<?`;
  if (cursor) sql += ' AND (f.minute_at>? OR (f.minute_at=? AND f.id>?))';
  return `${sql} ORDER BY f.minute_at ASC,f.id ASC LIMIT ?`;
}

async function loadRows(db, fromTs, toTs, cursor, limit) {
  const binds = [fromTs, toTs];
  if (cursor) binds.push(cursor.timestamp, cursor.timestamp, cursor.id);
  binds.push(limit + 1);
  return db.prepare(rawHistorySql(cursor)).bind(...binds).all();
}

export async function onRequestGet({ request, env }) {
  if (!env.MINUTE_DB) return json({ ok: false, error: 'MINUTE_DB binding missing' }, 500);
  const url = new URL(request.url);
  const from = url.searchParams.get('from') || '2024-06-01';
  const to = url.searchParams.get('to') || todayJstString();
  if (!validDateText(from) || !validDateText(to)) {
    return json({ ok: false, error: 'from and to must be valid YYYY-MM-DD dates' }, 400);
  }

  const fromTs = parseDateStart(from);
  const toTs = parseDateStart(to) + 86_400_000;
  if (fromTs >= toTs) {
    return json({ ok: false, error: 'from must not be after to' }, 400);
  }

  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 20), 500);
  const cursorValue = url.searchParams.get('cursor');
  const cursor = decodeRawHistoryCursor(cursorValue);
  if (cursorValue && !cursor) {
    return json({ ok: false, error: 'invalid cursor' }, 400);
  }
  if (cursor && (cursor.timestamp < fromTs || cursor.timestamp >= toTs)) {
    return json({ ok: false, error: 'cursor is outside the requested range' }, 400);
  }

  try {
    let result;
    try {
      result = await loadRows(env.MINUTE_DB, fromTs, toTs, cursor, limit);
    } catch (error) {
      if (!/no such table|no such view/i.test(String(error?.message || ''))) throw error;
      return json({ ok: false, error: 'minute facts history is not available from Pages' }, 503);
    }
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
      storage_source: 'stationhead-minute.sh_minute_facts',
    });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'raw history error' }, 500);
  }
}
