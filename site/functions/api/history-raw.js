const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, max-age=60',
  vary: 'accept-encoding',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

function validDateText(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function parseDateStart(value) {
  return Date.parse(`${value}T00:00:00Z`);
}

function todayUtcString() {
  return new Date().toISOString().slice(0, 10);
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

export function rawHistorySql(source, cursor) {
  let sql = `SELECT id,observed_at,
strftime('%Y-%m-%dT%H:%M:%SZ',observed_at/1000,'unixepoch') AS observed_utc,
observed_jst,listener_count,total_stream_count,
track_title,artist_name,likes,comment_velocity,host_handle,total_member_count,
source_note,quality_score,quality_flags
FROM ${source}
WHERE observed_at>=? AND observed_at<?`;
  if (cursor) sql += ' AND (observed_at>? OR (observed_at=? AND id>?))';
  return `${sql} ORDER BY observed_at ASC,id ASC LIMIT ?`;
}

async function loadRows(db, source, fromTs, toTs, cursor, limit) {
  const binds = [fromTs, toTs];
  if (cursor) binds.push(cursor.timestamp, cursor.timestamp, cursor.id);
  binds.push(limit + 1);
  return db.prepare(rawHistorySql(source, cursor)).bind(...binds).all();
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);
  const url = new URL(request.url);
  const from = url.searchParams.get('from') || '2024-06-01';
  const to = url.searchParams.get('to') || todayUtcString();
  if (!validDateText(from) || !validDateText(to)) {
    return json({ ok: false, error: 'from and to must be valid UTC YYYY-MM-DD dates' }, 400);
  }

  const fromTs = parseDateStart(from);
  const toTs = parseDateStart(to) + 86_400_000;
  if (fromTs >= toTs) return json({ ok: false, error: 'from must not be after to' }, 400);

  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 20), 500);
  const cursorValue = url.searchParams.get('cursor');
  const cursor = decodeRawHistoryCursor(cursorValue);
  if (cursorValue && !cursor) return json({ ok: false, error: 'invalid cursor' }, 400);
  if (cursor && (cursor.timestamp < fromTs || cursor.timestamp >= toTs)) {
    return json({ ok: false, error: 'cursor is outside the requested UTC range' }, 400);
  }

  try {
    let result;
    let source = 'lightweight';
    try {
      result = await loadRows(env.DB, 'sh_legacy_history_rows', fromTs, toTs, cursor, limit);
    } catch (error) {
      if (!/no such table|no such view/i.test(String(error?.message || ''))) throw error;
      result = await loadRows(env.DB, 'sh_legacy_snapshots', fromTs, toTs, cursor, limit);
      source = 'legacy-fallback';
    }
    const allRows = result.results || [];
    const hasMore = allRows.length > limit;
    const rows = hasMore ? allRows.slice(0, limit) : allRows;
    return json({
      ok: true,
      mode: 'raw',
      timezone: 'UTC',
      from,
      to,
      rows,
      has_more: hasMore,
      next_cursor: hasMore ? encodeCursor(rows.at(-1)) : null,
      storage_source: source,
    });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'raw history error' }, 500);
  }
}
