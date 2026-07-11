const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, max-age=30',
  vary: 'accept-encoding',
};
const JST_OFFSET_MS = 9 * 3_600_000;
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: status >= 400 ? { ...JSON_HEADERS, 'cache-control': 'no-store' } : JSON_HEADERS,
});

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

function normalizedSearch(value) {
  return String(value || '').trim().toLowerCase().slice(0, 100);
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (part) => `\\${part}`);
}

function encodeCursor(row) {
  return row ? btoa(`${row.observed_at}:${row.id}`) : null;
}

export function decodeMigratedCursor(value) {
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

export function migratedRowsSql(options = {}) {
  let sql = `SELECT s.legacy_id AS id,s.observed_at,s.observed_jst,
    s.listener_count,s.total_stream_count,t.title AS track_title,t.artist_name,
    s.likes,s.comment_velocity,h.handle AS host_handle,s.total_member_count,
    b.event_name AS source_note,s.quality_score,s.quality_flags
  FROM sh_legacy_samples s
  LEFT JOIN sh_legacy_tracks t ON t.id=s.track_id
  LEFT JOIN sh_legacy_hosts h ON h.id=s.host_id
  LEFT JOIN sh_legacy_broadcasts b ON b.id=s.broadcast_id
  WHERE s.observed_at>=? AND s.observed_at<?`;
  if (options.host) sql += ` AND lower(COALESCE(h.handle,'')) LIKE ? ESCAPE '\\'`;
  if (options.track) {
    sql += ` AND (lower(COALESCE(t.title,'')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(t.artist_name,'')) LIKE ? ESCAPE '\\')`;
  }
  if (options.cursor) sql += ' AND (s.observed_at>? OR (s.observed_at=? AND s.legacy_id>?))';
  return `${sql} ORDER BY s.observed_at ASC,s.legacy_id ASC LIMIT ?`;
}

export function migrationStatsSql() {
  return `SELECT
    (SELECT COUNT(*) FROM sh_legacy_samples) AS migrated_rows,
    (SELECT COUNT(*) FROM sh_legacy_snapshots) AS source_rows,
    (SELECT MIN(observed_at) FROM sh_legacy_samples) AS first_observed_at,
    (SELECT MAX(observed_at) FROM sh_legacy_samples) AS last_observed_at,
    (SELECT COUNT(*) FROM sh_legacy_tracks) AS track_dictionary_rows,
    (SELECT COUNT(*) FROM sh_legacy_hosts) AS host_dictionary_rows,
    (SELECT COUNT(*) FROM sh_legacy_broadcasts) AS broadcast_dictionary_rows,
    COALESCE((SELECT legacy_backfill_id FROM sh_data_maintenance_state
      WHERE id='rollup-retention-v1'),0) AS backfill_cursor`;
}

export function migrationProgress(stats = {}) {
  const migrated = Math.max(0, Number(stats.migrated_rows || 0));
  const source = Math.max(0, Number(stats.source_rows || 0));
  const remaining = Math.max(0, source - migrated);
  const percent = source > 0 ? Math.min(100, (migrated / source) * 100) : 0;
  return { migrated, source, remaining, percent };
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);
  const url = new URL(request.url);
  const from = url.searchParams.get('from') || '2024-06-01';
  const to = url.searchParams.get('to') || todayJstString();
  if (!validDateText(from) || !validDateText(to)) {
    return json({ ok: false, error: 'from and to must be valid YYYY-MM-DD dates' }, 400);
  }

  const fromTs = parseDateStart(from);
  const toTs = parseDateStart(to) + 86_400_000;
  if (fromTs >= toTs) return json({ ok: false, error: 'from must not be after to' }, 400);

  const requestedLimit = Number(url.searchParams.get('limit'));
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 200, 20), 500);
  const host = normalizedSearch(url.searchParams.get('host'));
  const track = normalizedSearch(url.searchParams.get('track'));
  const cursorValue = url.searchParams.get('cursor');
  const cursor = decodeMigratedCursor(cursorValue);
  if (cursorValue && !cursor) return json({ ok: false, error: 'invalid cursor' }, 400);
  if (cursor && (cursor.timestamp < fromTs || cursor.timestamp >= toTs)) {
    return json({ ok: false, error: 'cursor is outside the requested range' }, 400);
  }

  const binds = [fromTs, toTs];
  if (host) binds.push(`%${escapeLike(host)}%`);
  if (track) {
    const pattern = `%${escapeLike(track)}%`;
    binds.push(pattern, pattern);
  }
  if (cursor) binds.push(cursor.timestamp, cursor.timestamp, cursor.id);
  binds.push(limit + 1);

  try {
    const [rowsResult, stats] = await Promise.all([
      env.DB.prepare(migratedRowsSql({ host: Boolean(host), track: Boolean(track), cursor: Boolean(cursor) }))
        .bind(...binds).all(),
      env.DB.prepare(migrationStatsSql()).first(),
    ]);
    const allRows = rowsResult.results || [];
    const hasMore = allRows.length > limit;
    const rows = hasMore ? allRows.slice(0, limit) : allRows;
    return json({
      ok: true,
      mode: 'migrated-only',
      from,
      to,
      filters: { host, track },
      rows,
      has_more: hasMore,
      next_cursor: hasMore ? encodeCursor(rows.at(-1)) : null,
      progress: migrationProgress(stats),
      dictionaries: {
        tracks: Number(stats?.track_dictionary_rows || 0),
        hosts: Number(stats?.host_dictionary_rows || 0),
        broadcasts: Number(stats?.broadcast_dictionary_rows || 0),
      },
      first_observed_at: Number(stats?.first_observed_at || 0) || null,
      last_observed_at: Number(stats?.last_observed_at || 0) || null,
      backfill_cursor: Number(stats?.backfill_cursor || 0),
      storage_source: 'sh_legacy_samples',
    });
  } catch (error) {
    if (/no such table|no such view/i.test(String(error?.message || ''))) {
      return json({ ok: false, error: 'normalized legacy history is not installed', setup_required: true }, 503);
    }
    return json({ ok: false, error: error?.message || 'migrated history error' }, 500);
  }
}
