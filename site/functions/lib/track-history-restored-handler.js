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
export const TRACK_HISTORY_SQL = `WITH queue_starts AS (
      SELECT DISTINCT station_id,start_time
      FROM sh_queue_items
      WHERE start_time IS NOT NULL AND start_time < ?
    ), queue_instances AS (
      SELECT station_id,start_time,
        LEAD(start_time) OVER (
          PARTITION BY station_id ORDER BY start_time
        ) AS next_start_time
      FROM queue_starts
    ), snapshot_raw_evidence AS (
      SELECT queues.station_id,queues.start_time,
        MAX(snapshots.observed_at) AS evidence_end
      FROM queue_instances queues
      JOIN sh_queue_snapshots snapshots
        ON snapshots.station_id=queues.station_id
       AND snapshots.start_time=queues.start_time
       AND snapshots.observed_at>=?
       AND snapshots.observed_at<?
       AND (queues.next_start_time IS NULL OR snapshots.observed_at<queues.next_start_time)
      GROUP BY queues.station_id,queues.start_time
    ), channel_raw_evidence AS (
      SELECT queues.station_id,queues.start_time,
        MAX(snapshots.observed_at) AS evidence_end
      FROM queue_instances queues
      JOIN sh_channel_snapshots snapshots
        ON snapshots.station_id=queues.station_id
       AND snapshots.observed_at>=?
       AND snapshots.observed_at<?
       AND snapshots.observed_at>=queues.start_time
       AND (queues.next_start_time IS NULL OR snapshots.observed_at<queues.next_start_time)
      WHERE (
        COALESCE(snapshots.is_launched,0)=1
        OR COALESCE(snapshots.is_broadcasting,0)=1
        OR (snapshots.is_launched IS NULL AND snapshots.is_broadcasting IS NULL)
      )
      GROUP BY queues.station_id,queues.start_time
    ), item_raw_evidence AS (
      SELECT queues.station_id,queues.start_time,
        MAX(items.observed_at) AS evidence_end
      FROM queue_instances queues
      JOIN sh_queue_items items
        ON items.station_id=queues.station_id
       AND items.start_time=queues.start_time
       AND items.observed_at>=?
       AND items.observed_at<?
       AND (queues.next_start_time IS NULL OR items.observed_at<queues.next_start_time)
      GROUP BY queues.station_id,queues.start_time
    ), raw_evidence_rows AS (
      SELECT station_id,start_time,evidence_end FROM snapshot_raw_evidence
      UNION ALL
      SELECT station_id,start_time,evidence_end FROM channel_raw_evidence
      UNION ALL
      SELECT station_id,start_time,evidence_end FROM item_raw_evidence
    ), raw_evidence AS (
      SELECT station_id,start_time,MAX(evidence_end) AS evidence_end
      FROM raw_evidence_rows
      GROUP BY station_id,start_time
    ), initial_states AS (
      SELECT evidence.station_id,evidence.start_time,
        evidence.start_time AS state_at,
        0 AS state_id,
        COALESCE((
          SELECT snapshot.is_paused
          FROM sh_queue_snapshots snapshot
          WHERE snapshot.station_id=evidence.station_id
            AND snapshot.start_time=evidence.start_time
            AND snapshot.observed_at<=evidence.start_time
          ORDER BY snapshot.observed_at DESC,snapshot.id DESC
          LIMIT 1
        ),0) AS is_paused,
        evidence.evidence_end
      FROM raw_evidence evidence
    ), state_events AS (
      SELECT station_id,start_time,state_at,state_id,is_paused,evidence_end
      FROM initial_states
      UNION ALL
      SELECT evidence.station_id,evidence.start_time,
        snapshot.observed_at AS state_at,
        snapshot.id AS state_id,
        COALESCE(snapshot.is_paused,0) AS is_paused,
        evidence.evidence_end
      FROM raw_evidence evidence
      JOIN sh_queue_snapshots snapshot
        ON snapshot.station_id=evidence.station_id
       AND snapshot.start_time=evidence.start_time
       AND snapshot.observed_at>evidence.start_time
       AND snapshot.observed_at<=evidence.evidence_end
    ), state_spans AS (
      SELECT station_id,start_time,state_at,state_id,is_paused,evidence_end,
        MIN(
          COALESCE(LEAD(state_at) OVER (
            PARTITION BY station_id,start_time ORDER BY state_at,state_id
          ),evidence_end),
          evidence_end
        ) AS next_state_at
      FROM state_events
    ), active_spans AS (
      SELECT station_id,start_time,state_at,state_id,next_state_at,evidence_end,
        MAX(0,next_state_at-state_at) AS active_duration_ms,
        COALESCE(SUM(MAX(0,next_state_at-state_at)) OVER (
          PARTITION BY station_id,start_time ORDER BY state_at,state_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ),0) AS active_before_ms
      FROM state_spans
      WHERE COALESCE(is_paused,0)=0
    ), normalized AS (
      SELECT q.*,
        CASE
          WHEN q.duration_ms BETWEEN 1000 AND 21600000 THEN q.duration_ms
          ELSE NULL
        END AS normalized_duration_ms
      FROM sh_queue_items q
      JOIN raw_evidence evidence
        ON evidence.station_id=q.station_id AND evidence.start_time=q.start_time
      WHERE q.start_time < ?
    ), timed_offsets AS (
      SELECT n.*,
        COALESCE(SUM(n.normalized_duration_ms) OVER (
          PARTITION BY n.station_id,n.start_time ORDER BY n.position
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ),0) AS playback_offset_ms,
        COALESCE(SUM(CASE WHEN n.normalized_duration_ms IS NULL THEN 1 ELSE 0 END) OVER (
          PARTITION BY n.station_id,n.start_time ORDER BY n.position
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ),0) AS invalid_durations_before
      FROM normalized n
    ), timed AS (
      SELECT offsets.*,
        (
          SELECT span.state_at+(offsets.playback_offset_ms-span.active_before_ms)
          FROM active_spans span
          WHERE span.station_id=offsets.station_id
            AND span.start_time=offsets.start_time
            AND offsets.playback_offset_ms>=span.active_before_ms
            AND (
              offsets.playback_offset_ms<span.active_before_ms+span.active_duration_ms
              OR (
                span.next_state_at=span.evidence_end
                AND offsets.playback_offset_ms<=span.active_before_ms+span.active_duration_ms+?
              )
            )
          ORDER BY span.active_before_ms DESC,span.state_at DESC,span.state_id DESC
          LIMIT 1
        ) AS played_at
      FROM timed_offsets offsets
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
      WHERE p.played_at IS NOT NULL
        AND p.played_at >= ? AND p.played_at < ?
        AND p.invalid_durations_before = 0
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
    toTs,
    fromTs - TRACK_HISTORY_GRACE_MS, toTs,
    fromTs - TRACK_HISTORY_GRACE_MS, toTs,
    fromTs - TRACK_HISTORY_GRACE_MS, toTs,
    toTs,
    TRACK_HISTORY_GRACE_MS,
    fromTs, toTs,
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
      historical_recovery: 'channel_snapshots_with_wall_clock_pause_mapping',
      method: 'queue_checkpoint_and_wall_clock_active_span_reachability_utc_sql_preaggregate',
    });
  } catch (error) {
    if (/no such table|no such column|malformed JSON/i.test(String(error?.message || ''))) {
      return out({ ok: true, mode: 'tracks', rows: [], setup_required: true, timezone: 'UTC' });
    }
    return out({ ok: false, error: error?.message || 'track history error' }, 500);
  }
}
