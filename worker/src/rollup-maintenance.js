import {
  DAY_MS,
  jstDayStartUtc,
  previousJstDay,
  utcMonthlyRange,
  utcWeeklyRange,
} from '../../site/functions/lib/time-buckets.js';

const STATE_ID = 'rollup-retention-v1';
const STREAM_REPAIR_STATE_ID = 'rollup-stream-repair-2026-07-v3';
const STREAM_REPAIR_KEYS = Object.freeze(['2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13']);
const STREAM_VALUE_SQL = `COALESCE(
  CASE WHEN validated_stream_count IS NOT NULL AND validated_stream_count>=0
    AND validated_stream_count IS NOT total_listens THEN validated_stream_count END,
  CASE WHEN current_stream_count IS NOT NULL AND current_stream_count>=0
    AND current_stream_count IS NOT total_listens THEN current_stream_count END
)`;

function finite(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function upsertSummary(db, table, key, aggregate, first, last, primaryHost, updatedAt) {
  if (!aggregate || Number(aggregate.sample_count || 0) < 1) return false;
  const streamStart = finite(first?.stream_start);
  const streamEnd = finite(last?.stream_end);
  const memberStart = finite(first?.member_start);
  const memberEnd = finite(last?.member_end);
  await db.prepare(`INSERT INTO ${table}(
      period_key,period_start,period_end,sample_count,reliable_sample_count,
      listener_avg,listener_min,listener_max,stream_start,stream_end,stream_growth,
      member_start,member_end,member_growth,likes_max,distinct_tracks,primary_host,
      quality_score,quality_flags,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(period_key) DO UPDATE SET
      period_start=excluded.period_start,period_end=excluded.period_end,
      sample_count=excluded.sample_count,reliable_sample_count=excluded.reliable_sample_count,
      listener_avg=excluded.listener_avg,listener_min=excluded.listener_min,
      listener_max=excluded.listener_max,stream_start=excluded.stream_start,
      stream_end=excluded.stream_end,stream_growth=excluded.stream_growth,
      member_start=excluded.member_start,member_end=excluded.member_end,
      member_growth=excluded.member_growth,likes_max=excluded.likes_max,
      distinct_tracks=excluded.distinct_tracks,primary_host=excluded.primary_host,
      quality_score=excluded.quality_score,quality_flags=excluded.quality_flags,
      updated_at=excluded.updated_at`).bind(
    key, finite(aggregate.period_start), finite(aggregate.period_end),
    Number(aggregate.sample_count || 0),
    Number(aggregate.reliable_sample_count ?? aggregate.sample_count ?? 0),
    finite(aggregate.listener_avg), finite(aggregate.listener_min), finite(aggregate.listener_max),
    streamStart, streamEnd,
    streamStart != null && streamEnd != null && streamEnd >= streamStart ? streamEnd - streamStart : null,
    memberStart, memberEnd, memberStart != null && memberEnd != null ? memberEnd - memberStart : null,
    finite(aggregate.likes_max), finite(aggregate.distinct_tracks), primaryHost || null,
    finite(aggregate.quality_score) ?? 1, '["live_rollup"]', updatedAt,
  ).run();
  return true;
}

async function rollupDaily(db, otherDb, period, now) {
  const aggregate = await db.prepare(`SELECT MIN(observed_at) AS period_start,MAX(observed_at) AS period_end,
      COUNT(*) AS sample_count,COUNT(listener_count) AS reliable_sample_count,
      AVG(listener_count) AS listener_avg,MIN(listener_count) AS listener_min,
      MAX(listener_count) AS listener_max,NULL AS likes_max,NULL AS distinct_tracks,1 AS quality_score
    FROM sh_channel_snapshots WHERE observed_at>=? AND observed_at<?`)
    .bind(period.start, period.end).first();
  if (!aggregate || Number(aggregate.sample_count || 0) < 1) return false;
  const boundaries = await db.prepare(`SELECT
      (SELECT ${STREAM_VALUE_SQL} FROM sh_channel_snapshots
       WHERE observed_at>=? AND observed_at<? AND ${STREAM_VALUE_SQL} IS NOT NULL
       ORDER BY observed_at ASC,id ASC LIMIT 1) AS stream_start,
      (SELECT ${STREAM_VALUE_SQL} FROM sh_channel_snapshots
       WHERE observed_at>=? AND observed_at<? AND ${STREAM_VALUE_SQL} IS NOT NULL
       ORDER BY observed_at DESC,id DESC LIMIT 1) AS stream_end,
      (SELECT total_member_count FROM sh_channel_snapshots
       WHERE observed_at>=? AND observed_at<? AND total_member_count IS NOT NULL
       ORDER BY observed_at ASC,id ASC LIMIT 1) AS member_start,
      (SELECT total_member_count FROM sh_channel_snapshots
       WHERE observed_at>=? AND observed_at<? AND total_member_count IS NOT NULL
       ORDER BY observed_at DESC,id DESC LIMIT 1) AS member_end,
      (SELECT host_handle FROM sh_channel_snapshots
       WHERE observed_at>=? AND observed_at<? AND host_handle IS NOT NULL AND host_handle<>''
       GROUP BY host_handle ORDER BY COUNT(*) DESC,host_handle ASC LIMIT 1) AS primary_host`)
    .bind(
      period.start, period.end,
      period.start, period.end,
      period.start, period.end,
      period.start, period.end,
      period.start, period.end,
    ).first();
  return upsertSummary(
    otherDb,
    'sh_daily_summary',
    period.key,
    aggregate,
    boundaries,
    boundaries,
    boundaries?.primary_host,
    now,
  );
}

async function rollupFromDaily(otherDb, table, range, now) {
  const aggregate = await otherDb.prepare(`SELECT MIN(period_start) AS period_start,MAX(period_end) AS period_end,
      SUM(sample_count) AS sample_count,SUM(reliable_sample_count) AS reliable_sample_count,
      CASE WHEN SUM(CASE WHEN listener_avg IS NOT NULL THEN reliable_sample_count ELSE 0 END)>0
        THEN SUM(listener_avg*reliable_sample_count)
          /SUM(CASE WHEN listener_avg IS NOT NULL THEN reliable_sample_count ELSE 0 END) END AS listener_avg,
      MIN(listener_min) AS listener_min,MAX(listener_max) AS listener_max,
      MAX(likes_max) AS likes_max,NULL AS distinct_tracks,
      CASE WHEN SUM(reliable_sample_count)>0
        THEN SUM(quality_score*reliable_sample_count)/SUM(reliable_sample_count) ELSE 1 END AS quality_score
    FROM sh_daily_summary WHERE period_key>=? AND period_key<?`)
    .bind(range.startKey, range.endKey).first();
  if (!aggregate || Number(aggregate.sample_count || 0) < 1) return false;
  const boundaries = await otherDb.prepare(`SELECT
      (SELECT stream_start FROM sh_daily_summary
       WHERE period_key>=? AND period_key<? AND stream_start IS NOT NULL
       ORDER BY period_key ASC LIMIT 1) AS stream_start,
      (SELECT stream_end FROM sh_daily_summary
       WHERE period_key>=? AND period_key<? AND stream_end IS NOT NULL
       ORDER BY period_key DESC LIMIT 1) AS stream_end,
      (SELECT member_start FROM sh_daily_summary
       WHERE period_key>=? AND period_key<? AND member_start IS NOT NULL
       ORDER BY period_key ASC LIMIT 1) AS member_start,
      (SELECT member_end FROM sh_daily_summary
       WHERE period_key>=? AND period_key<? AND member_end IS NOT NULL
       ORDER BY period_key DESC LIMIT 1) AS member_end,
      (SELECT primary_host FROM sh_daily_summary
       WHERE period_key>=? AND period_key<? AND primary_host IS NOT NULL AND primary_host<>''
       GROUP BY primary_host ORDER BY SUM(reliable_sample_count) DESC,primary_host ASC LIMIT 1) AS primary_host`)
    .bind(
      range.startKey, range.endKey,
      range.startKey, range.endKey,
      range.startKey, range.endKey,
      range.startKey, range.endKey,
      range.startKey, range.endKey,
    ).first();
  return upsertSummary(
    otherDb,
    table,
    range.key,
    aggregate,
    boundaries,
    boundaries,
    boundaries?.primary_host,
    now,
  );
}

function jstPeriod(dayKey) {
  const start = jstDayStartUtc(dayKey);
  return { key: dayKey, start, end: start + DAY_MS };
}

async function repairContaminatedSummaries(db, otherDb, now) {
  const state = await db.prepare(`SELECT last_rollup_key FROM sh_data_maintenance_state WHERE id=?`)
    .bind(STREAM_REPAIR_STATE_ID).first();
  if (state?.last_rollup_key === STREAM_REPAIR_KEYS.at(-1)) {
    return { skipped: true, reason: 'already-repaired' };
  }

  const repairedDays = [];
  for (const key of STREAM_REPAIR_KEYS) {
    if (await rollupDaily(db, otherDb, jstPeriod(key), now)) repairedDays.push(key);
  }
  if (repairedDays.length !== STREAM_REPAIR_KEYS.length) {
    return { skipped: true, reason: 'repair-source-data-missing', repairedDays };
  }

  const weeks = new Map();
  const months = new Map();
  for (const key of repairedDays) {
    const week = utcWeeklyRange(key);
    const month = utcMonthlyRange(key);
    weeks.set(week.key, week);
    months.set(month.key, month);
  }

  const repairedWeeks = [];
  for (const [key, range] of weeks) {
    if (await rollupFromDaily(otherDb, 'sh_weekly_summary', range, now)) repairedWeeks.push(key);
  }
  const repairedMonths = [];
  for (const [key, range] of months) {
    if (await rollupFromDaily(otherDb, 'sh_monthly_summary', range, now)) repairedMonths.push(key);
  }
  if (repairedWeeks.length !== weeks.size || repairedMonths.length !== months.size) {
    return {
      skipped: true,
      reason: 'repair-summary-write-incomplete',
      repairedDays,
      repairedWeeks,
      repairedMonths,
    };
  }

  await db.prepare(`INSERT INTO sh_data_maintenance_state(
      id,last_rollup_key,last_cleanup_at,legacy_backfill_id,updated_at
    ) VALUES(?,?,0,0,?) ON CONFLICT(id) DO UPDATE SET
      last_rollup_key=excluded.last_rollup_key,updated_at=excluded.updated_at`)
    .bind(STREAM_REPAIR_STATE_ID, STREAM_REPAIR_KEYS.at(-1), now).run();
  return { skipped: false, repairedDays, repairedWeeks, repairedMonths };
}

// sh_channel_snapshots/sh_data_maintenance_state stay on `db` (buddies'
// database); the daily/weekly/monthly summary tables this produces live on
// `otherDb` since they're read exclusively by sh-monitor-other/site.
export async function runRollupMaintenance(db, otherDb, now = Date.now()) {
  if (!db || !otherDb) return { skipped: true, reason: 'db-binding-missing' };
  const summaryRepair = await repairContaminatedSummaries(db, otherDb, now);
  const period = previousJstDay(now);
  const state = await db.prepare(`SELECT last_rollup_key FROM sh_data_maintenance_state WHERE id=?`)
    .bind(STATE_ID).first();
  if (state?.last_rollup_key === period.key) {
    return { skipped: true, reason: 'already-rolled-up', periodKey: period.key, summaryRepair };
  }
  const dailyWritten = await rollupDaily(db, otherDb, period, now);
  if (!dailyWritten) return { skipped: true, reason: 'no-source-data', periodKey: period.key, summaryRepair };
  await rollupFromDaily(otherDb, 'sh_weekly_summary', utcWeeklyRange(period.key), now);
  await rollupFromDaily(otherDb, 'sh_monthly_summary', utcMonthlyRange(period.key), now);
  await db.prepare(`INSERT INTO sh_data_maintenance_state(
      id,last_rollup_key,last_cleanup_at,legacy_backfill_id,updated_at
    ) VALUES(?,?,0,0,?) ON CONFLICT(id) DO UPDATE SET
      last_rollup_key=excluded.last_rollup_key,updated_at=excluded.updated_at`)
    .bind(STATE_ID, period.key, now).run();
  return {
    skipped: false,
    rolledUp: true,
    periodKey: period.key,
    summaryRepair,
    legacyBackfill: { skipped: true, reason: 'legacy-migration-disabled' },
  };
}

export async function runRollupMaintenanceSafely(db, otherDb, now = Date.now()) {
  try {
    return await runRollupMaintenance(db, otherDb, now);
  } catch (error) {
    console.error('D1 rollup maintenance failed', error);
    return { skipped: true, reason: 'maintenance-error', error: error?.message || String(error) };
  }
}
