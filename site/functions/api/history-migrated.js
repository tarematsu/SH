const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, max-age=30',
  vary: 'accept-encoding',
};
const JST_OFFSET_MS = 9 * 3_600_000;
const ALLOWED_SOURCES = new Set(['live_collector', 'live_reconstructed', 'legacy_normalized', 'legacy_raw']);
// sh_minute_facts source and track detection values are dictionary-coded
// integers; these mirror the codes defined in worker/src/minute-facts-store.js.
const SOURCE_CODES = Object.freeze({
  live_collector: 1,
  live_reconstructed: 2,
  legacy_normalized: 3,
  legacy_raw: 4,
});
const SOURCE_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(SOURCE_CODES).map(([name, code]) => [code, name])),
);
const TRACK_DETECTION_NAMES = Object.freeze({
  0: 'unknown',
  1: 'queue_inferred',
  2: 'queue_reconstructed',
});
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
  return row ? btoa(`${row.minute_at}:${row.id}`) : null;
}

export function decodeFactRow(row) {
  const { source_code, track_detection_code, ...rest } = row;
  return {
    ...rest,
    source: SOURCE_NAMES[Number(source_code)] || null,
    track_detection_method: TRACK_DETECTION_NAMES[Number(track_detection_code)] || 'unknown',
  };
}

export function decodeMinuteFactsCursor(value) {
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

export const decodeMigratedCursor = decodeMinuteFactsCursor;

export function minuteFactsRowsSql(options = {}) {
  let sql = `SELECT
    f.id,f.channel_id,c.station_id,f.minute_at,f.observed_at,f.received_at,
    f.source_code,f.source_priority,f.source_record_id,fc.collector_id,
    f.broadcast_session_id,f.is_broadcasting,c.broadcast_start_time,
    f.listener_count,f.online_member_count,
    COALESCE((SELECT d.last_total_member_count FROM sh_total_member_daily d
      WHERE d.channel_id=f.channel_id AND d.day_at=(f.observed_at/86400000)*86400000
        AND d.host_key IN (0,COALESCE(c.host_id,0))
      ORDER BY d.host_key DESC,d.last_observed_at DESC LIMIT 1),f.total_member_count)
      AS total_member_count,f.guest_count,
    CASE WHEN f.source_code=1 THEN f.reported_total_listens ELSE NULL END
      AS cumulative_listener_count,
    CASE WHEN f.source_code=1 THEN f.reported_current_stream_count
      ELSE COALESCE(f.reported_current_stream_count,f.reported_total_listens) END
      AS total_stream_count,c.queue_revision_id,c.queue_id,c.queue_start_time,
    f.is_paused,c.queue_track_count,c.queue_available,c.queue_position,
    f.track_detection_code,f.track_confidence_code/100.0 AS track_confidence,
    f.schedule_valid,c.track_bite_count,f.comment_count,f.comment_total,
    f.comments_degraded,f.quality_score_code/100.0 AS quality_score,f.quality_flags,
    t.title AS track_title,t.artist AS artist_name,t.isrc,t.spotify_id,
    h.current_handle AS host_handle,
    s.status AS session_status,s.source AS session_source,
    r.status AS revision_status,r.item_count AS revision_item_count
  FROM sh_minute_facts f
  LEFT JOIN sh_minute_fact_context c ON c.fact_id=f.id
  LEFT JOIN sh_minute_fact_collectors fc ON fc.collector_code=f.collector_code
  LEFT JOIN sh_tracks t ON t.id=c.track_id
  LEFT JOIN sh_hosts h ON h.id=c.host_id
  LEFT JOIN sh_broadcast_sessions s ON s.id=f.broadcast_session_id
  LEFT JOIN sh_queue_revisions r ON r.id=c.queue_revision_id
  `;
  if (!options.latest) {
    sql += ' WHERE f.minute_at>=? AND f.minute_at<?';
    if (options.source) sql += ' AND f.source_code=?';
    if (options.host) sql += ` AND lower(COALESCE(h.current_handle,'')) LIKE ? ESCAPE '\\'`;
    if (options.track) {
      sql += ` AND (lower(COALESCE(t.title,'')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(t.artist,'')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(t.isrc,'')) LIKE ? ESCAPE '\\')`;
    }
    if (options.cursor) sql += ' AND (f.minute_at>? OR (f.minute_at=? AND f.id>?))';
  }
  return `${sql} ORDER BY f.minute_at ${options.latest ? 'DESC' : 'ASC'},f.id ${options.latest ? 'DESC' : 'ASC'} LIMIT ?`;
}

export const migratedRowsSql = minuteFactsRowsSql;

export function minuteFactsStatsSql() {
  return `SELECT
    COUNT(*) AS total_rows,
    SUM(CASE WHEN source_code=1 THEN 1 ELSE 0 END) AS live_rows,
    SUM(CASE WHEN source_code=2 THEN 1 ELSE 0 END) AS reconstructed_rows,
    SUM(CASE WHEN source_code=3 THEN 1 ELSE 0 END) AS normalized_rows,
    SUM(CASE WHEN source_code=4 THEN 1 ELSE 0 END) AS raw_rows,
    MIN(observed_at) AS first_observed_at,
    MAX(observed_at) AS last_observed_at,
    (SELECT COUNT(*) FROM sh_tracks) AS track_rows,
    (SELECT COUNT(*) FROM sh_hosts) AS host_rows,
    (SELECT COUNT(*) FROM sh_broadcast_sessions) AS session_rows,
    (SELECT COUNT(*) FROM sh_queue_revisions WHERE status='complete') AS complete_revision_rows
  FROM sh_minute_facts`;
}

export const migrationStatsSql = minuteFactsStatsSql;

export function migrationStateSql() {
  return `SELECT migration_key,phase,cursor_observed_at,cursor_source_id,
    migrated_rows,error_rows,last_error,updated_at
  FROM sh_migration_state
  WHERE migration_key='legacy-minute-facts-v1'
  LIMIT 1`;
}

function sourceSummary(stats = {}) {
  const normalized = Math.max(0, Number(stats.normalized_rows || 0));
  const raw = Math.max(0, Number(stats.raw_rows || 0));
  const reconstructed = Math.max(0, Number(stats.reconstructed_rows || 0));
  return {
    total: Math.max(0, Number(stats.total_rows || 0)),
    live: Math.max(0, Number(stats.live_rows || 0)),
    live_reconstructed: reconstructed,
    legacy_normalized: normalized,
    legacy_raw: raw,
    legacy: normalized + raw,
  };
}

const LATEST_FACT_SQL = `SELECT id,source_code,minute_at,observed_at,received_at
  FROM sh_minute_facts
  ORDER BY minute_at DESC,id DESC LIMIT 1`;
const LATEST_LIVE_FACT_SQL = `SELECT id,source_code,minute_at,observed_at,received_at
  FROM sh_minute_facts
  WHERE source_code=1
  ORDER BY minute_at DESC,id DESC LIMIT 1`;

async function loadLatestFacts(env, limit = 1440) {
  const [rowsResult, latestAny, latestLive] = await Promise.all([
    env.MINUTE_DB.prepare(minuteFactsRowsSql({ latest: true })).bind(limit).all(),
    env.MINUTE_DB.prepare(LATEST_FACT_SQL).first(),
    env.MINUTE_DB.prepare(LATEST_LIVE_FACT_SQL).first(),
  ]);
  const rows = (rowsResult.results || []).map(decodeFactRow).reverse();
  return {
    ok: true,
    mode: 'current',
    database_name: 'stationhead-minute',
    limit,
    rows,
    latest_any: latestAny ? { ...latestAny, source: SOURCE_NAMES[Number(latestAny.source_code)] || null } : null,
    latest_live: latestLive ? { ...latestLive, source: SOURCE_NAMES[Number(latestLive.source_code)] || null } : null,
    latest_observed_at: Number(latestLive?.observed_at || 0) || null,
    storage_source: 'stationhead-minute.sh_minute_facts',
  };
}

export async function onRequestGet({ request, env }) {
  if (!env.MINUTE_DB) return json({ ok: false, error: 'MINUTE_DB binding missing' }, 500);
  const url = new URL(request.url);
  if (url.searchParams.get('latest') === '1') {
    try {
      return json(await loadLatestFacts(env));
    } catch (error) {
      if (/no such table|no such view/i.test(String(error?.message || ''))) {
        return json({ ok: false, error: 'stationhead-minute minute facts schema is not installed', setup_required: true }, 503);
      }
      return json({ ok: false, error: error?.message || 'current minute facts error' }, 500);
    }
  }
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
  const source = String(url.searchParams.get('source') || '').trim();
  if (source && !ALLOWED_SOURCES.has(source)) {
    return json({ ok: false, error: 'invalid source filter' }, 400);
  }

  const cursorValue = url.searchParams.get('cursor');
  const cursor = decodeMinuteFactsCursor(cursorValue);
  if (cursorValue && !cursor) return json({ ok: false, error: 'invalid cursor' }, 400);
  if (cursor && (cursor.timestamp < fromTs || cursor.timestamp >= toTs)) {
    return json({ ok: false, error: 'cursor is outside the requested range' }, 400);
  }

  const binds = [fromTs, toTs];
  if (source) binds.push(SOURCE_CODES[source]);
  if (host) binds.push(`%${escapeLike(host)}%`);
  if (track) {
    const pattern = `%${escapeLike(track)}%`;
    binds.push(pattern, pattern, pattern);
  }
  if (cursor) binds.push(cursor.timestamp, cursor.timestamp, cursor.id);
  binds.push(limit + 1);

  try {
    const [rowsResult, stats, migration] = await Promise.all([
      env.MINUTE_DB.prepare(minuteFactsRowsSql({
        source: Boolean(source),
        host: Boolean(host),
        track: Boolean(track),
        cursor: Boolean(cursor),
      })).bind(...binds).all(),
      env.MINUTE_DB.prepare(minuteFactsStatsSql()).first(),
      env.MINUTE_DB.prepare(migrationStateSql()).first(),
    ]);
    const allRows = rowsResult.results || [];
    const hasMore = allRows.length > limit;
    const rows = (hasMore ? allRows.slice(0, limit) : allRows).map(decodeFactRow);
    return json({
      ok: true,
      mode: 'minute-facts',
      database_name: 'stationhead-minute',
      from,
      to,
      filters: { source, host, track },
      rows,
      has_more: hasMore,
      next_cursor: hasMore ? encodeCursor(rows.at(-1)) : null,
      summary: sourceSummary(stats),
      catalog: {
        tracks: Number(stats?.track_rows || 0),
        hosts: Number(stats?.host_rows || 0),
        sessions: Number(stats?.session_rows || 0),
        revisions: Number(stats?.complete_revision_rows || 0),
      },
      migration: migration ? {
        key: migration.migration_key,
        phase: migration.phase,
        cursor_observed_at: Number(migration.cursor_observed_at || 0),
        cursor_source_id: Number(migration.cursor_source_id || 0),
        migrated_rows: Number(migration.migrated_rows || 0),
        error_rows: Number(migration.error_rows || 0),
        last_error: migration.last_error || null,
        updated_at: Number(migration.updated_at || 0),
      } : null,
      first_observed_at: Number(stats?.first_observed_at || 0) || null,
      last_observed_at: Number(stats?.last_observed_at || 0) || null,
      storage_source: 'stationhead-minute.sh_minute_facts',
    });
  } catch (error) {
    if (/no such table|no such view/i.test(String(error?.message || ''))) {
      return json({ ok: false, error: 'Stationhead-DB minute facts schema is not installed', setup_required: true }, 503);
    }
    return json({ ok: false, error: error?.message || 'minute facts history error' }, 500);
  }
}
