import {
  HOUR_MS,
  previousJstDay,
  utcMonthlyRange,
  utcWeeklyRange,
} from './time-buckets.js';

const MAINTENANCE_CLAIM_MS = 15 * 60_000;
const STATE_ID = 'rollup-retention-v1';
const LEGACY_MIGRATION_DISABLED_REASON = 'legacy-migration-disabled';
const runtimeState = new WeakMap();

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function changedRows(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
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

async function rollupDaily(db, period, now) {
  const aggregate = await db.prepare(`SELECT MIN(observed_at) AS period_start,MAX(observed_at) AS period_end,
      COUNT(*) AS sample_count,COUNT(listener_count) AS reliable_sample_count,
      AVG(listener_count) AS listener_avg,MIN(listener_count) AS listener_min,
      MAX(listener_count) AS listener_max,NULL AS likes_max,NULL AS distinct_tracks,1 AS quality_score
    FROM sh_channel_snapshots WHERE observed_at>=? AND observed_at<?`)
    .bind(period.start, period.end).first();
  if (!aggregate || Number(aggregate.sample_count || 0) < 1) return false;

  const first = await db.prepare(`SELECT
      (SELECT validated_stream_count
       FROM sh_channel_snapshots
       WHERE observed_at>=? AND observed_at<? AND validated_stream_count IS NOT NULL
       ORDER BY observed_at ASC,id ASC LIMIT 1) AS stream_start,
      (SELECT total_member_count
       FROM sh_channel_snapshots
       WHERE observed_at>=? AND observed_at<? AND total_member_count IS NOT NULL
       ORDER BY observed_at ASC,id ASC LIMIT 1) AS member_start`)
    .bind(period.start, period.end, period.start, period.end).first();
  const last = await db.prepare(`SELECT
      (SELECT validated_stream_count
       FROM sh_channel_snapshots
       WHERE observed_at>=? AND observed_at<? AND validated_stream_count IS NOT NULL
       ORDER BY observed_at DESC,id DESC LIMIT 1) AS stream_end,
      (SELECT total_member_count
       FROM sh_channel_snapshots
       WHERE observed_at>=? AND observed_at<? AND total_member_count IS NOT NULL
       ORDER BY observed_at DESC,id DESC LIMIT 1) AS member_end`)
    .bind(period.start, period.end, period.start, period.end).first();
  const host = await db.prepare(`SELECT host_handle FROM sh_channel_snapshots
    WHERE observed_at>=? AND observed_at<? AND host_handle IS NOT NULL AND host_handle<>''
    GROUP BY host_handle ORDER BY COUNT(*) DESC,host_handle ASC LIMIT 1`)
    .bind(period.start, period.end).first();
  return upsertSummary(db, 'sh_daily_summary', period.key, aggregate, first, last, host?.host_handle, now);
}

async function rollupFromDaily(db, table, range, now) {
  const aggregate = await db.prepare(`SELECT MIN(period_start) AS period_start,MAX(period_end) AS period_end,
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

  const first = await db.prepare(`SELECT
      (SELECT stream_start FROM sh_daily_summary
       WHERE period_key>=? AND period_key<? AND stream_start IS NOT NULL
       ORDER BY period_key ASC LIMIT 1) AS stream_start,
      (SELECT member_start FROM sh_daily_summary
       WHERE period_key>=? AND period_key<? AND member_start IS NOT NULL
       ORDER BY period_key ASC LIMIT 1) AS member_start`)
    .bind(range.startKey, range.endKey, range.startKey, range.endKey).first();
  const last = await db.prepare(`SELECT
      (SELECT stream_end FROM sh_daily_summary
       WHERE period_key>=? AND period_key<? AND stream_end IS NOT NULL
       ORDER BY period_key DESC LIMIT 1) AS stream_end,
      (SELECT member_end FROM sh_daily_summary
       WHERE period_key>=? AND period_key<? AND member_end IS NOT NULL
       ORDER BY period_key DESC LIMIT 1) AS member_end`)
    .bind(range.startKey, range.endKey, range.startKey, range.endKey).first();
  const host = await db.prepare(`SELECT primary_host FROM sh_daily_summary
    WHERE period_key>=? AND period_key<? AND primary_host IS NOT NULL AND primary_host<>''
    GROUP BY primary_host ORDER BY SUM(reliable_sample_count) DESC,primary_host ASC LIMIT 1`)
    .bind(range.startKey, range.endKey).first();
  return upsertSummary(db, table, range.key, aggregate, first, last, host?.primary_host, now);
}

export function legacyMigrationEnabled() {
  return false;
}

export async function runDataMaintenance(db, now = Date.now()) {
  if (!db) return { skipped: true, reason: 'missing-db' };
  const cached = runtimeState.get(db);
  if (cached?.nextCheckAt > now) return { skipped: true, reason: 'memory-cadence' };
  runtimeState.set(db, { nextCheckAt: now + HOUR_MS });

  let claimAt = null;
  try {
    const state = await db.prepare(`SELECT last_rollup_key,last_cleanup_at,legacy_backfill_id,updated_at
      FROM sh_data_maintenance_state WHERE id=?`).bind(STATE_ID).first();
    const lastMaintenanceAt = Number(state?.updated_at || 0);
    if (lastMaintenanceAt > 0 && now - lastMaintenanceAt < HOUR_MS) {
      const nextCheckAt = lastMaintenanceAt + HOUR_MS;
      runtimeState.set(db, { nextCheckAt });
      return { skipped: true, reason: 'persistent-cadence', nextCheckAt };
    }

    claimAt = now - HOUR_MS + MAINTENANCE_CLAIM_MS;
    const claim = await db.prepare(`INSERT INTO sh_data_maintenance_state(
        id,last_rollup_key,last_cleanup_at,legacy_backfill_id,updated_at
      ) VALUES(?,NULL,0,0,?) ON CONFLICT(id) DO UPDATE SET
      updated_at=excluded.updated_at
      WHERE sh_data_maintenance_state.updated_at=?`)
      .bind(STATE_ID, claimAt, lastMaintenanceAt).run();
    if (changedRows(claim) < 1) {
      const latest = await db.prepare(`SELECT updated_at FROM sh_data_maintenance_state WHERE id=?`)
        .bind(STATE_ID).first();
      const latestAt = Number(latest?.updated_at || 0);
      const nextCheckAt = latestAt > 0
        ? latestAt + HOUR_MS
        : now + MAINTENANCE_CLAIM_MS;
      runtimeState.set(db, { nextCheckAt });
      return { skipped: true, reason: 'maintenance-claimed', nextCheckAt };
    }
    runtimeState.set(db, { nextCheckAt: claimAt + HOUR_MS });

    const period = previousJstDay(now);
    let lastRollupKey = state?.last_rollup_key || null;
    const lastCleanupAt = Number(state?.last_cleanup_at || 0);
    const legacyBackfillId = Number(state?.legacy_backfill_id || 0);
    let rolledUp = false;
    const cleaned = false;

    if (lastRollupKey !== period.key) {
      const dailyWritten = await rollupDaily(db, period, now);
      if (dailyWritten) {
        await rollupFromDaily(db, 'sh_weekly_summary', utcWeeklyRange(period.key), now);
        await rollupFromDaily(db, 'sh_monthly_summary', utcMonthlyRange(period.key), now);
        lastRollupKey = period.key;
        rolledUp = true;
      }
    }

    await db.prepare(`INSERT INTO sh_data_maintenance_state(
        id,last_rollup_key,last_cleanup_at,legacy_backfill_id,updated_at
      ) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      last_rollup_key=CASE
        WHEN sh_data_maintenance_state.last_rollup_key IS NULL THEN excluded.last_rollup_key
        WHEN excluded.last_rollup_key IS NULL THEN sh_data_maintenance_state.last_rollup_key
        WHEN excluded.last_rollup_key>sh_data_maintenance_state.last_rollup_key THEN excluded.last_rollup_key
        ELSE sh_data_maintenance_state.last_rollup_key END,
      last_cleanup_at=MAX(sh_data_maintenance_state.last_cleanup_at,excluded.last_cleanup_at),
      legacy_backfill_id=MAX(sh_data_maintenance_state.legacy_backfill_id,excluded.legacy_backfill_id),
      updated_at=MAX(sh_data_maintenance_state.updated_at,excluded.updated_at)`)
      .bind(STATE_ID, lastRollupKey, lastCleanupAt, legacyBackfillId, now).run();
    runtimeState.set(db, { nextCheckAt: now + HOUR_MS });

    return {
      skipped: false,
      rolledUp,
      cleaned,
      periodKey: period.key,
      legacyBackfill: {
        skipped: true,
        reason: LEGACY_MIGRATION_DISABLED_REASON,
      },
    };
  } catch (error) {
    if (claimAt == null) runtimeState.delete(db);
    else runtimeState.set(db, { nextCheckAt: claimAt + HOUR_MS });
    throw error;
  }
}

export async function runDataMaintenanceSafely(db, now = Date.now()) {
  try {
    return await runDataMaintenance(db, now);
  } catch (error) {
    console.error('D1 data maintenance failed', error);
    return { skipped: true, reason: 'maintenance-error', error: error?.message || String(error) };
  }
}

export function resetDataMaintenanceRuntimeState(db) {
  if (db) runtimeState.delete(db);
}
