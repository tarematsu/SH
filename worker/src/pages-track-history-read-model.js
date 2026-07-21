import {
  loadTrackHistoryData,
  TRACK_HISTORY_GRACE_MS,
} from '../../site/functions/lib/track-history-restored-handler.js';
import { mergeTrackRows } from '../../site/functions/lib/track-history-merge.js';
import { applyTrackPeriodCompleteness } from '../../site/functions/lib/period-completeness.js';
import { attachCompactTrackLikes } from '../../site/functions/lib/track-likes.js';
import { loadTrackRanking } from '../../site/functions/lib/track-ranking.js';
import {
  mergeTrackHistoryExcludedDates,
  trackHistoryRefreshRanges,
} from './pages-track-history-support.js';
import {
  readPagesPayload,
  savePagesPayload,
} from './pages-read-model-publication.js';

const DAY_MS = 86_400_000;
const TRACK_HISTORY_EPOCH = Date.UTC(2024, 4, 1);
const TRACK_HISTORY_LIMIT = 40_000;
const TRACK_RANKING_LIMIT = 500;

function dayText(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function trackRowKey(row) {
  return [
    row.play_date || '',
    row.stationhead_track_id ?? '',
    row.isrc || '',
    row.spotify_id || '',
    row.queue_track_id ?? '',
    row.position ?? '',
    row.first_played_at ?? row.played_at ?? '',
  ].join('|');
}

function parsedPayload(row) {
  try {
    return row?.payload_json ? JSON.parse(row.payload_json) : null;
  } catch {
    return null;
  }
}

function validTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
}

async function materializeTrackHistoryRange(sourceDb, targetDb, range, now) {
  const { result, likeRows } = await loadTrackHistoryData(
    sourceDb,
    range.fromTs,
    range.toTs,
    TRACK_HISTORY_LIMIT,
    true,
  );
  const groupedRows = result.results || [];
  if (groupedRows.length > TRACK_HISTORY_LIMIT) {
    throw new Error(`track history read-model range exceeded ${TRACK_HISTORY_LIMIT} grouped rows`);
  }
  const mergedRows = mergeTrackRows(groupedRows);
  const likedRows = attachCompactTrackLikes(mergedRows, likeRows);
  const completed = applyTrackPeriodCompleteness(likedRows, groupedRows);
  const rows = completed.rows;
  const fromDay = dayText(range.fromTs);
  const toDay = dayText(range.toTs - DAY_MS);
  const statements = rows.map((row) => targetDb.prepare(`INSERT INTO sh_pages_track_history_read_model(
      row_key,play_date,first_played_at,row_json,updated_at
    ) VALUES(?,?,?,?,?) ON CONFLICT(row_key) DO UPDATE SET
      play_date=excluded.play_date,
      first_played_at=excluded.first_played_at,
      row_json=excluded.row_json,
      updated_at=excluded.updated_at`)
    .bind(
      trackRowKey(row),
      row.play_date,
      Number(row.first_played_at || row.played_at || 0) || null,
      JSON.stringify(row),
      now,
    ));
  for (let offset = 0; offset < statements.length; offset += 100) {
    await targetDb.batch(statements.slice(offset, offset + 100));
  }
  await targetDb.prepare(`DELETE FROM sh_pages_track_history_read_model
    WHERE play_date>=? AND play_date<=? AND updated_at<>?`)
    .bind(fromDay, toDay, now).run();
  return {
    from: fromDay,
    to: toDay,
    rows: rows.length,
    groupedRows: groupedRows.length,
    sourceRowCount: groupedRows.reduce((sum, row) => sum + (Number(row.play_count) || 0), 0),
    excludedDates: completed.excludedDates,
  };
}

export async function refreshTrackHistoryReadModel(sourceDb, targetDb, now, dependencies = {}) {
  const [backfillRow, statusRow] = await Promise.all([
    readPagesPayload(targetDb, 'track-history-backfill'),
    readPagesPayload(targetDb, 'track-history-status'),
  ]);
  const backfillState = parsedPayload(backfillRow);
  const previousStatus = parsedPayload(statusRow) || {};
  const ranges = trackHistoryRefreshRanges(now, backfillState, previousStatus);
  const recent = await materializeTrackHistoryRange(sourceDb, targetDb, ranges.recent, now);
  let backfill = null;
  if (ranges.backfill) {
    backfill = await materializeTrackHistoryRange(sourceDb, targetDb, ranges.backfill, now);
    await savePagesPayload(targetDb, 'track-history-backfill', {
      next_to: ranges.backfill.fromTs,
      completed: ranges.backfill.fromTs <= TRACK_HISTORY_EPOCH,
      updated_at: now,
    }, now);
  } else {
    await savePagesPayload(targetDb, 'track-history-backfill', {
      next_to: TRACK_HISTORY_EPOCH,
      completed: true,
      updated_at: now,
    }, now);
  }

  const fullFromDay = dayText(ranges.fullRecent.fromTs);
  const fullToDay = dayText(ranges.fullRecent.toTs - DAY_MS);
  const [coverage, ranking] = await Promise.all([
    targetDb.prepare(`SELECT
        MIN(play_date) AS earliest_date,
        MAX(play_date) AS latest_date,
        COALESCE(SUM(CASE WHEN play_date>=? AND play_date<=? THEN 1 ELSE 0 END),0) AS recent_row_count
      FROM sh_pages_track_history_read_model`)
      .bind(fullFromDay, fullToDay)
      .first(),
    (dependencies.loadRanking || loadTrackRanking)(targetDb, { limit: TRACK_RANKING_LIMIT }),
  ]);
  const previousSourceRowCount = Number(previousStatus.source_row_count);
  const previousSourceRefreshedAt = validTimestamp(
    previousStatus.source_row_count_refreshed_at
      ?? previousStatus.full_reconciled_at
      ?? previousStatus.generated_at,
  );
  const fullReconciledAt = ranges.fullReconcile ? now : ranges.previousFullAt;
  const sourceRowCount = ranges.fullReconcile || !Number.isFinite(previousSourceRowCount)
    ? recent.sourceRowCount
    : previousSourceRowCount;
  const sourceRowCountRefreshedAt = ranges.fullReconcile || previousSourceRefreshedAt == null
    ? now
    : previousSourceRefreshedAt;
  const excludedDates = ranges.fullReconcile
    ? recent.excludedDates
    : mergeTrackHistoryExcludedDates(
      previousStatus.excluded_play_count_dates,
      recent.excludedDates,
      ranges.recent,
    );
  await savePagesPayload(targetDb, 'track-history-status', {
    ok: true,
    from: coverage?.earliest_date || recent.from,
    to: coverage?.latest_date || recent.to,
    row_count: Math.max(0, Number(coverage?.recent_row_count || 0)),
    source_row_count: sourceRowCount,
    source_row_count_refreshed_at: sourceRowCountRefreshedAt,
    source_truncated: false,
    excluded_play_count_dates: excludedDates,
    ranking: ranking.rows,
    ranking_summary: ranking.summary,
    ranking_scope: 'all-time-latest-counter',
    grace_ms: TRACK_HISTORY_GRACE_MS,
    backfill_completed: !ranges.backfill || ranges.backfill.fromTs <= TRACK_HISTORY_EPOCH,
    backfill_from: backfill?.from || null,
    backfill_to: backfill?.to || null,
    refresh_mode: ranges.fullReconcile ? 'full' : 'incremental',
    refresh_from: recent.from,
    refresh_to: recent.to,
    full_reconciled_at: fullReconciledAt,
    generated_at: now,
  }, now);
  return {
    recent,
    backfill,
    ranking: { rows: ranking.rows.length, summary: ranking.summary },
    refreshMode: ranges.fullReconcile ? 'full' : 'incremental',
    fullReconciledAt,
  };
}
