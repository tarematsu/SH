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
const valid = (value) => {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const valueTs = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(valueTs) && new Date(valueTs).toISOString().slice(0, 10) === text;
};
const ts = (value) => Date.parse(`${value}T00:00:00Z`);

export const TRACK_HISTORY_GRACE_MS = 5 * 60 * 1000;
export const TRACK_HISTORY_SQL = `WITH RECURSIVE queue_starts AS (
      SELECT DISTINCT station_id,start_time
      FROM sh_queue_items
      WHERE start_time IS NOT NULL AND start_time < ?
    ), queue_instances AS (
      SELECT station_id,start_time,
        LAG(start_time) OVER (
          PARTITION BY station_id ORDER BY start_time
        ) AS previous_start_time,
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
    ), ordered_state_events AS (
      SELECT state_events.*,
        LAG(is_paused) OVER (
          PARTITION BY station_id,start_time ORDER BY state_at,state_id
        ) AS previous_is_paused
      FROM state_events
    ), state_changes AS (
      SELECT station_id,start_time,state_at,state_id,is_paused,evidence_end
      FROM ordered_state_events
      WHERE previous_is_paused IS NULL OR is_paused IS NOT previous_is_paused
    ), ordered_state_changes AS (
      SELECT state_changes.*,
        LEAD(state_at) OVER (
          PARTITION BY station_id,start_time ORDER BY state_at,state_id
        ) AS following_state_at
      FROM state_changes
    ), state_spans AS (
      SELECT station_id,start_time,state_at,state_id,is_paused,evidence_end,
        MIN(COALESCE(following_state_at,evidence_end),evidence_end) AS next_state_at,
        CASE WHEN following_state_at IS NULL THEN 1 ELSE 0 END AS is_terminal
      FROM ordered_state_changes
    ), active_spans AS (
      SELECT station_id,start_time,state_at,state_id,next_state_at,evidence_end,is_terminal,
        MAX(0,next_state_at-state_at) AS active_duration_ms,
        COALESCE(SUM(MAX(0,next_state_at-state_at)) OVER (
          PARTITION BY station_id,start_time ORDER BY state_at,state_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ),0) AS active_before_ms
      FROM state_spans
      WHERE COALESCE(is_paused,0)=0
    ), normalized AS (
      SELECT q.*,queues.previous_start_time,queues.next_start_time,
        CASE WHEN json_valid(q.raw_json) THEN q.raw_json ELSE '{}' END AS safe_raw_json,
        CASE
          WHEN q.duration_ms BETWEEN 1000 AND 21600000 THEN q.duration_ms
          ELSE NULL
        END AS normalized_duration_ms
      FROM sh_queue_items q
      JOIN queue_instances queues
        ON queues.station_id=q.station_id AND queues.start_time=q.start_time
      JOIN raw_evidence evidence
        ON evidence.station_id=q.station_id AND evidence.start_time=q.start_time
      WHERE q.start_time < ?
    ), timed_offsets AS (
      SELECT n.*,
        ROW_NUMBER() OVER (
          PARTITION BY n.station_id,n.start_time ORDER BY n.position
        ) AS queue_item_rank,
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
                span.is_terminal=1
                AND offsets.playback_offset_ms<=span.active_before_ms+span.active_duration_ms+?
              )
            )
          ORDER BY span.active_before_ms DESC,span.state_at DESC,span.state_id DESC
          LIMIT 1
        ) AS played_at
      FROM timed_offsets offsets
    ), timed_queues AS (
      SELECT station_id,start_time,previous_start_time,next_start_time,
        ROW_NUMBER() OVER (
          PARTITION BY station_id ORDER BY start_time
        ) AS timed_queue_rank
      FROM (
        SELECT DISTINCT station_id,start_time,previous_start_time,next_start_time
        FROM timed
      )
    ), queue_adjustments(
      station_id,timed_queue_rank,start_time,playback_shift_ms,continuation_item_id
    ) AS (
      SELECT queues.station_id,queues.timed_queue_rank,queues.start_time,0,NULL
      FROM timed_queues queues
      WHERE queues.timed_queue_rank=1
      UNION ALL
      SELECT current_queue.station_id,current_queue.timed_queue_rank,current_queue.start_time,
        CASE WHEN previous_item.id IS NULL THEN 0
          ELSE current_queue.start_time-(previous_item.played_at-previous_adjustment.playback_shift_ms)
        END AS playback_shift_ms,
        CASE WHEN previous_item.id IS NULL THEN NULL ELSE current_first.id END AS continuation_item_id
      FROM queue_adjustments previous_adjustment
      JOIN timed_queues current_queue
        ON current_queue.station_id=previous_adjustment.station_id
       AND current_queue.timed_queue_rank=previous_adjustment.timed_queue_rank+1
      JOIN timed current_first
        ON current_first.station_id=current_queue.station_id
       AND current_first.start_time=current_queue.start_time
       AND current_first.queue_item_rank=1
      LEFT JOIN timed previous_item
        ON current_queue.previous_start_time=previous_adjustment.start_time
       AND previous_item.station_id=previous_adjustment.station_id
       AND previous_item.start_time=previous_adjustment.start_time
       AND previous_item.played_at IS NOT NULL
       AND previous_item.normalized_duration_ms IS NOT NULL
       AND previous_item.invalid_durations_before=0
       AND previous_item.played_at-previous_adjustment.playback_shift_ms<current_queue.start_time
       AND previous_item.played_at-previous_adjustment.playback_shift_ms
         +previous_item.normalized_duration_ms>current_queue.start_time
       AND (
         (current_first.queue_track_id IS NOT NULL
           AND current_first.queue_track_id=previous_item.queue_track_id)
         OR (current_first.stationhead_track_id IS NOT NULL
           AND current_first.stationhead_track_id=previous_item.stationhead_track_id)
         OR (current_first.spotify_id IS NOT NULL
           AND current_first.spotify_id=previous_item.spotify_id)
         OR (current_first.apple_music_id IS NOT NULL
           AND current_first.apple_music_id=previous_item.apple_music_id)
         OR (current_first.isrc IS NOT NULL
           AND UPPER(current_first.isrc)=UPPER(previous_item.isrc))
       )
    ), adjusted_timed AS (
      SELECT timed.*,
        timed.played_at-adjustments.playback_shift_ms AS adjusted_played_at,
        CASE WHEN timed.id=adjustments.continuation_item_id THEN 1 ELSE 0 END AS is_continuation
      FROM timed
      JOIN queue_adjustments adjustments
        ON adjustments.station_id=timed.station_id
       AND adjustments.start_time=timed.start_time
    ), plays AS (
      SELECT
        strftime('%Y-%m-%d', p.adjusted_played_at / 1000, 'unixepoch') AS play_date,
        p.adjusted_played_at AS played_at,p.position,p.queue_track_id,p.stationhead_track_id,
        p.spotify_id,p.apple_music_id,p.isrc,p.bite_count AS queue_like_count,
        NULLIF(m.title, '') AS title,
        NULLIF(m.artist, '') AS artist,
        NULLIF(m.display_title, '') AS display_title,
        NULLIF(m.spotify_url, '') AS spotify_url,
        COALESCE(
          NULLIF(json_extract(p.safe_raw_json, '$.track.title'), ''),
          NULLIF(json_extract(p.safe_raw_json, '$.track.name'), ''),
          NULLIF(json_extract(p.safe_raw_json, '$.title'), ''),
          NULLIF(json_extract(p.safe_raw_json, '$.name'), '')
        ) AS raw_title,
        COALESCE(
          NULLIF(json_extract(p.safe_raw_json, '$.track.artist_name'), ''),
          NULLIF(json_extract(p.safe_raw_json, '$.track.artist'), ''),
          NULLIF(json_extract(p.safe_raw_json, '$.track.artists[0].name'), ''),
          NULLIF(json_extract(p.safe_raw_json, '$.artist_name'), ''),
          NULLIF(json_extract(p.safe_raw_json, '$.artist'), ''),
          NULLIF(json_extract(p.safe_raw_json, '$.artists[0].name'), '')
        ) AS raw_artist
      FROM adjusted_timed p
      LEFT JOIN sh_track_metadata m ON m.spotify_id = p.spotify_id
      WHERE p.adjusted_played_at IS NOT NULL
        AND p.adjusted_played_at >= ? AND p.adjusted_played_at < ?
        AND p.invalid_durations_before = 0
        AND (p.next_start_time IS NULL OR p.adjusted_played_at<p.next_start_time)
        AND p.is_continuation=0
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
      MAX(plays.queue_like_count) AS like_count,
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
  const db = env.MINUTE_DB || env.DB;
  if (!db) return out({ ok: false, error: 'MINUTE_DB binding missing' }, 500);
  const url = new URL(request.url);
  try {
    if (url.searchParams.get('latest') === '1') {
      const latest = await db.prepare(`SELECT strftime('%Y-%m-%d', MAX(observed_at) / 1000, 'unixepoch') AS play_date
        FROM sh_queue_snapshots WHERE COALESCE(is_paused, 0) = 0`).first();
      return out({ ok: true, latest_date: latest?.play_date || null, timezone: 'UTC' });
    }

    const fromParam = url.searchParams.get('from');
    const toParam = url.searchParams.get('to');
    if ((fromParam !== null && !valid(fromParam)) || (toParam !== null && !valid(toParam))) {
      return out({ ok: false, error: 'invalid date range' }, 400);
    }
    const from = fromParam || '2024-05-01';
    const to = toParam || day();
    const fromTs = ts(from);
    const toTs = ts(to) + 86400000;
    const parsedLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(Math.max(Math.trunc(parsedLimit), 100), 20000)
      : 10000;
    const includeLikes = url.searchParams.get('likes') === '1';
    if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) {
      return out({ ok: false, error: 'invalid date range' }, 400);
    }

    const maxGroupedRows = Math.min(limit * 8, 40000);
    const { result, likeRows } = await loadTrackHistoryData(
      db,
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
      waitUntil(refreshMissingMetadata(groupedRows, { ...env, DB: db }).catch((error) => {
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
      historical_recovery: env.MINUTE_DB
        ? 'facts_downstream_archive_with_wall_clock_pause_mapping'
        : 'channel_snapshots_with_wall_clock_pause_mapping',
      method: 'queue_checkpoint_terminal_active_span_revision_boundary_carryover_and_namespaced_like_reachability_utc_sql_preaggregate',
    });
  } catch (error) {
    if (/no such table|no such column/i.test(String(error?.message || ''))) {
      return out({ ok: true, mode: 'tracks', rows: [], setup_required: true, timezone: 'UTC' });
    }
    return out({ ok: false, error: error?.message || 'track history error' }, 500);
  }
}
