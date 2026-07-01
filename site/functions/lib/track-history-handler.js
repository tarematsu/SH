import { refreshMissingMetadata } from './track-history-metadata.js';
import { mergeTrackRows } from './track-history-merge.js';
import {
  PERIOD_BOUNDARY_TOLERANCE_MS,
  applyTrackPeriodCompleteness,
} from './period-completeness.js';
import {
  attachCompactTrackLikes,
  compactTrackLikeBatchResults,
  loadTrackLikeRows,
  trackLikeStatements,
} from './track-likes.js';

const H = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600',
};
const out = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: H });
const day = () => new Date().toISOString().slice(0, 10);
const valid = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '');
const ts = (value) => Date.parse(`${value}T00:00:00Z`);

export const TRACK_HISTORY_GRACE_MS = 5 * 60 * 1000;

export const TRACK_HISTORY_SQL = `WITH snapshot_evidence AS (
      SELECT station_id, start_time, MAX(observed_at) AS queue_last_observed_at
      FROM sh_queue_snapshots
      WHERE start_time IS NOT NULL
        AND start_time < ?
        AND observed_at >= ?
        AND COALESCE(is_paused, 0) = 0
      GROUP BY station_id, start_time
    ), item_evidence AS (
      SELECT q.station_id, q.start_time, MAX(q.observed_at) AS queue_last_observed_at
      FROM sh_queue_items q
      WHERE q.start_time < ?
        AND q.observed_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM sh_queue_snapshots s
          WHERE s.station_id = q.station_id AND s.start_time = q.start_time
        )
      GROUP BY q.station_id, q.start_time
    ), queue_evidence AS (
      SELECT station_id, start_time, queue_last_observed_at FROM snapshot_evidence
      UNION ALL
      SELECT station_id, start_time, queue_last_observed_at FROM item_evidence
    ), normalized AS (
      SELECT q.*, e.queue_last_observed_at,
        CASE
          WHEN q.duration_ms BETWEEN 1000 AND 21600000 THEN q.duration_ms
          ELSE NULL
        END AS normalized_duration_ms
      FROM sh_queue_items q
      JOIN queue_evidence e
        ON e.station_id = q.station_id AND e.start_time = q.start_time
      WHERE q.start_time < ?
    ), timed AS (
      SELECT n.*,
        n.start_time + COALESCE(SUM(n.normalized_duration_ms) OVER (
          PARTITION BY n.station_id, n.start_time ORDER BY n.position
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0) AS played_at,
        COALESCE(SUM(CASE WHEN n.normalized_duration_ms IS NULL THEN 1 ELSE 0 END) OVER (
          PARTITION BY n.station_id, n.start_time ORDER BY n.position
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0) AS invalid_durations_before
      FROM normalized n
    ), plays AS (
      SELECT
        strftime('%Y-%m-%d', p.played_at / 1000, 'unixepoch') AS play_date,
        p.played_at,p.position,p.queue_track_id,p.stationhead_track_id,
        p.spotify_id,p.apple_music_id,p.isrc,
        NULLIF(m.title, '') AS title,
        NULLIF(m.artist, '') AS artist,
        NULLIF(m.display_title, '') AS display_title,
        NULLIF(m.spotify_url, '') AS spotify_url,
        COALESCE(
          NULLIF(json_extract(p.raw_json, '$.track.title'), ''),
          NULLIF(json_extract(p.raw_json, '$.track.name'), ''),
          NULLIF(json_extract(p.raw_json, '$.title'), ''),
          NULLIF(json_extract(p.raw_json, '$.name'), '')
        ) AS raw_title,
        COALESCE(
          NULLIF(json_extract(p.raw_json, '$.track.artist_name'), ''),
          NULLIF(json_extract(p.raw_json, '$.track.artist'), ''),
          NULLIF(json_extract(p.raw_json, '$.track.artists[0].name'), ''),
          NULLIF(json_extract(p.raw_json, '$.artist_name'), ''),
          NULLIF(json_extract(p.raw_json, '$.artist'), ''),
          NULLIF(json_extract(p.raw_json, '$.artists[0].name'), '')
        ) AS raw_artist
      FROM timed p
      LEFT JOIN sh_track_metadata m ON m.spotify_id = p.spotify_id
      WHERE p.played_at >= ? AND p.played_at < ?
        AND p.invalid_durations_before = 0
        AND p.played_at <= p.queue_last_observed_at + ?
    ), play_days AS (
      SELECT DISTINCT play_date,
        CAST(strftime('%s', play_date) AS INTEGER) * 1000 AS period_start,
        CAST(strftime('%s', play_date) AS INTEGER) * 1000 + 86400000 AS period_end
      FROM plays
    ), coverage_range AS (
      SELECT ? AS range_start,? AS range_end
    ), coverage_boundaries AS (
      SELECT play_date,'start' AS boundary_name,period_start AS target_at FROM play_days
      UNION ALL
      SELECT play_date,'end' AS boundary_name,period_end AS target_at FROM play_days
    ), coverage_candidates AS (
      SELECT boundaries.play_date,boundaries.boundary_name,boundaries.target_at,
        snapshots.observed_at,snapshots.id AS source_id
      FROM coverage_boundaries boundaries
      JOIN sh_channel_snapshots snapshots
        ON snapshots.observed_at BETWEEN boundaries.target_at-${PERIOD_BOUNDARY_TOLERANCE_MS}
          AND boundaries.target_at+${PERIOD_BOUNDARY_TOLERANCE_MS}
      CROSS JOIN coverage_range
      WHERE snapshots.observed_at >= coverage_range.range_start-${PERIOD_BOUNDARY_TOLERANCE_MS}
        AND snapshots.observed_at <= coverage_range.range_end+${PERIOD_BOUNDARY_TOLERANCE_MS}
    ), coverage_ranked AS (
      SELECT coverage_candidates.*,
        ROW_NUMBER() OVER (
          PARTITION BY play_date,boundary_name
          ORDER BY ABS(observed_at-target_at),
            CASE WHEN boundary_name='start' THEN -observed_at ELSE observed_at END,source_id
        ) AS boundary_rank
      FROM coverage_candidates
    ), coverage AS (
      SELECT play_date,
        MAX(CASE WHEN boundary_name='start' AND boundary_rank=1 THEN observed_at END)
          AS period_first_observed_at,
        MAX(CASE WHEN boundary_name='end' AND boundary_rank=1 THEN observed_at END)
          AS period_last_observed_at
      FROM coverage_ranked GROUP BY play_date
    )
    SELECT
      plays.play_date,
      MIN(plays.played_at) AS played_at,
      MIN(plays.played_at) AS first_played_at,
      MAX(plays.played_at) AS last_played_at,
      COUNT(*) AS play_count,
      MIN(plays.position) AS position,
      MIN(plays.queue_track_id) AS queue_track_id,
      plays.stationhead_track_id,plays.spotify_id,plays.apple_music_id,plays.isrc,
      MAX(plays.title) AS title,MAX(plays.artist) AS artist,
      MAX(plays.display_title) AS display_title,MAX(plays.spotify_url) AS spotify_url,
      MAX(plays.raw_title) AS raw_title,MAX(plays.raw_artist) AS raw_artist,
      MAX(coverage.period_first_observed_at) AS period_first_observed_at,
      MAX(coverage.period_last_observed_at) AS period_last_observed_at
    FROM plays
    LEFT JOIN coverage ON coverage.play_date=plays.play_date
    GROUP BY
      plays.play_date,plays.stationhead_track_id,plays.spotify_id,plays.apple_music_id,plays.isrc,
      CASE
        WHEN plays.spotify_id IS NULL AND plays.apple_music_id IS NULL AND plays.isrc IS NULL
          AND plays.stationhead_track_id IS NULL THEN plays.queue_track_id
        ELSE NULL
      END,
      CASE
        WHEN plays.spotify_id IS NULL AND plays.apple_music_id IS NULL AND plays.isrc IS NULL
          AND plays.stationhead_track_id IS NULL AND plays.queue_track_id IS NULL THEN plays.position
        ELSE NULL
      END
    ORDER BY first_played_at ASC
    LIMIT ?`;

function trackHistoryStatement(db, fromTs, toTs, maxGroupedRows) {
  return db.prepare(TRACK_HISTORY_SQL).bind(
    toTs, fromTs - TRACK_HISTORY_GRACE_MS,
    toTs, fromTs - TRACK_HISTORY_GRACE_MS,
    toTs,
    fromTs, toTs,
    TRACK_HISTORY_GRACE_MS,
    fromTs, toTs,
    maxGroupedRows + 1,
  );
}

export async function loadTrackHistoryData(db, fromTs, toTs, maxGroupedRows, includeLikes) {
  if (!includeLikes) {
    return { result: await trackHistoryStatement(db, fromTs, toTs, maxGroupedRows).all(), likeRows: [] };
  }

  if (typeof db.batch === 'function') {
    try {
      const [result, ...likeResults] = await db.batch([
        trackHistoryStatement(db, fromTs, toTs, maxGroupedRows),
        ...trackLikeStatements(db, fromTs, toTs),
      ]);
      return { result, likeRows: compactTrackLikeBatchResults(likeResults) };
    } catch (error) {
      if (!/no such table|no such column/i.test(String(error?.message || ''))) throw error;
    }
  }

  const [result, likeRows] = await Promise.all([
    trackHistoryStatement(db, fromTs, toTs, maxGroupedRows).all(),
    loadTrackLikeRows(db, fromTs, toTs),
  ]);
  return { result, likeRows };
}

export async function handleTrackHistory({ request, env, waitUntil }) {
  if (!env.DB) return out({ ok: false, error: 'DB binding missing' }, 500);
  const url = new URL(request.url);
  try {
    if (url.searchParams.get('latest') === '1') {
      const latest = await env.DB.prepare(`SELECT strftime('%Y-%m-%d', MAX(observed_at) / 1000, 'unixepoch') AS play_date
        FROM sh_queue_snapshots WHERE COALESCE(is_paused, 0) = 0`).first();
      return out({ ok: true, latest_date: latest?.play_date || null, timezone: 'UTC' });
    }

    const from = valid(url.searchParams.get('from')) ? url.searchParams.get('from') : '2024-05-01';
    const to = valid(url.searchParams.get('to')) ? url.searchParams.get('to') : day();
    const fromTs = ts(from);
    const toTs = ts(to) + 86400000;
    const limit = Math.min(Math.max(+url.searchParams.get('limit') || 10000, 100), 20000);
    const includeLikes = url.searchParams.get('likes') === '1';
    if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) {
      return out({ ok: false, error: 'invalid date range' }, 400);
    }

    const maxGroupedRows = Math.min(limit * 8, 40000);
    const { result, likeRows } = await loadTrackHistoryData(
      env.DB,
      fromTs,
      toTs,
      maxGroupedRows,
      includeLikes,
    );

    const allGroupedRows = result.results || [];
    const sourceTruncated = allGroupedRows.length > maxGroupedRows;
    const groupedRows = sourceTruncated ? allGroupedRows.slice(0, maxGroupedRows) : allGroupedRows;
    const mergedRows = mergeTrackRows(groupedRows);
    const likedRows = includeLikes ? attachCompactTrackLikes(mergedRows, likeRows) : mergedRows;
    const completed = applyTrackPeriodCompleteness(likedRows, groupedRows);
    const rows = completed.rows;
    const metadataRefreshScheduled = typeof waitUntil === 'function';
    if (metadataRefreshScheduled) {
      waitUntil(refreshMissingMetadata(groupedRows, env).catch((error) => {
        console.error('track metadata background refresh failed', error);
      }));
    }
    const truncated = sourceTruncated || rows.length > limit;
    return out({
      ok: true,
      mode: 'tracks',
      from,
      to,
      timezone: 'UTC',
      rows: rows.length > limit ? rows.slice(0, limit) : rows,
      truncated,
      source_truncated: sourceTruncated,
      source_row_count: groupedRows.reduce((sum, row) => sum + (Number(row.play_count) || 0), 0),
      grouped_row_count: groupedRows.length,
      likes_included: includeLikes,
      like_row_count: likeRows.length,
      excluded_play_count_dates: completed.excludedDates,
      excluded_play_count_date_count: completed.excludedDates.length,
      metadata_refresh_scheduled: metadataRefreshScheduled,
      method: 'observed_unpaused_queue_reachability_utc_sql_preaggregate_with_symmetric_boundary_evidence',
    });
  } catch (error) {
    if (/no such table|no such column|malformed JSON/i.test(String(error?.message || ''))) {
      return out({ ok: true, mode: 'tracks', rows: [], setup_required: true, timezone: 'UTC' });
    }
    return out({ ok: false, error: error?.message || 'track history error' }, 500);
  }
}
