const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const JST_OFFSET_MS = 9 * HOUR_MS;
const CLEANUP_BATCH = 5_000;
const LEGACY_BACKFILL_BATCH = 1_000;
const MAINTENANCE_CLAIM_MS = 15 * 60_000;
const STATE_ID = 'rollup-retention-v1';
const runtimeState = new WeakMap();

function jstDayKey(timestamp) {
  return new Date(timestamp + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function dayStartUtc(dayKey) {
  return Date.parse(`${dayKey}T00:00:00Z`) - JST_OFFSET_MS;
}

function previousDay(now) {
  const today = jstDayKey(now);
  const end = dayStartUtc(today);
  const start = end - DAY_MS;
  return { key: jstDayKey(start), start, end };
}

function weeklyRange(dayKey) {
  const date = new Date(`${dayKey}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  const startKey = date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() + 7);
  return { key: startKey, startKey, endKey: date.toISOString().slice(0, 10) };
}

function monthlyRange(dayKey) {
  const [year, month] = dayKey.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return {
    key: dayKey.slice(0, 7),
    startKey: start.toISOString().slice(0, 10),
    endKey: end.toISOString().slice(0, 10),
  };
}

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
    streamStart, streamEnd, streamStart != null && streamEnd != null && streamEnd >= streamStart ? streamEnd - streamStart : null,
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

async function cleanup(db, now) {
  await db.batch([
    db.prepare(`DELETE FROM sh_channel_snapshots WHERE id IN (
      SELECT id FROM sh_channel_snapshots WHERE observed_at<? ORDER BY observed_at ASC LIMIT ?
    )`).bind(now - 90 * DAY_MS, CLEANUP_BATCH),
    db.prepare(`DELETE FROM sh_raw_events WHERE id IN (
      SELECT id FROM sh_raw_events WHERE observed_at<? ORDER BY observed_at ASC LIMIT ?
    )`).bind(now - 7 * DAY_MS, CLEANUP_BATCH),
    db.prepare(`DELETE FROM sh_realtime_metrics WHERE id IN (
      SELECT id FROM sh_realtime_metrics WHERE observed_at<? ORDER BY observed_at ASC LIMIT ?
    )`).bind(now - 7 * DAY_MS, CLEANUP_BATCH),
    db.prepare(`DELETE FROM sh_queue_snapshots WHERE id IN (
      SELECT id FROM sh_queue_snapshots WHERE observed_at<? ORDER BY observed_at ASC LIMIT ?
    )`).bind(now - 30 * DAY_MS, CLEANUP_BATCH),
  ]);
}

async function backfillLegacySamples(db, lastLegacyId) {
  const boundary = await db.prepare(`SELECT MAX(id) AS batch_end,COUNT(*) AS batch_count FROM (
      SELECT id FROM sh_legacy_snapshots WHERE id>? ORDER BY id ASC LIMIT ?
    )`).bind(lastLegacyId, LEGACY_BACKFILL_BATCH).first();
  const batchEnd = Number(boundary?.batch_end || 0);
  const batchCount = Number(boundary?.batch_count || 0);
  if (!batchEnd || batchEnd <= lastLegacyId) {
    return { lastLegacyId, migrated: 0, complete: true };
  }

  const hostKey = `lower(trim(host_handle))`;
  const trackKey = `lower(trim(COALESCE(track_title,''))) || char(31) || lower(trim(COALESCE(artist_name,'')))`;
  const broadcastKey = `lower(trim(source_note)) || char(31) || lower(trim(COALESCE(host_handle,'')))`;

  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO sh_legacy_hosts(host_key,handle)
      SELECT ${hostKey},MIN(host_handle) FROM sh_legacy_snapshots
      WHERE id>? AND id<=? AND host_handle IS NOT NULL AND trim(host_handle)<>''
      GROUP BY ${hostKey}`).bind(lastLegacyId, batchEnd),
    db.prepare(`INSERT OR IGNORE INTO sh_legacy_tracks(track_key,title,artist_name)
      SELECT ${trackKey},MIN(track_title),MIN(artist_name) FROM sh_legacy_snapshots
      WHERE id>? AND id<=? AND (trim(COALESCE(track_title,''))<>'' OR trim(COALESCE(artist_name,''))<>'')
      GROUP BY ${trackKey}`).bind(lastLegacyId, batchEnd),
    db.prepare(`INSERT OR IGNORE INTO sh_legacy_broadcasts(broadcast_key,event_name,host_id)
      SELECT ${broadcastKey},MIN(l.source_note),MIN(h.id)
      FROM sh_legacy_snapshots l
      LEFT JOIN sh_legacy_hosts h ON h.host_key=lower(trim(l.host_handle))
      WHERE l.id>? AND l.id<=? AND l.source_note IS NOT NULL AND trim(l.source_note)<>''
      GROUP BY ${broadcastKey}`).bind(lastLegacyId, batchEnd),
    db.prepare(`INSERT OR IGNORE INTO sh_legacy_samples(
        legacy_id,observed_at,observed_jst,listener_count,total_stream_count,
        track_id,likes,comment_velocity,host_id,total_member_count,broadcast_id,
        quality_score,quality_flags
      )
      SELECT l.id,l.observed_at,l.observed_jst,l.listener_count,l.total_stream_count,
        t.id,l.likes,l.comment_velocity,h.id,l.total_member_count,b.id,
        COALESCE(l.quality_score,1),COALESCE(l.quality_flags,'[]')
      FROM sh_legacy_snapshots l
      LEFT JOIN sh_legacy_hosts h ON h.host_key=lower(trim(l.host_handle))
      LEFT JOIN sh_legacy_tracks t ON t.track_key=(lower(trim(COALESCE(l.track_title,''))) || char(31) || lower(trim(COALESCE(l.artist_name,''))))
      LEFT JOIN sh_legacy_broadcasts b ON b.broadcast_key=(lower(trim(l.source_note)) || char(31) || lower(trim(COALESCE(l.host_handle,''))))
      WHERE l.id>? AND l.id<=?`).bind(lastLegacyId, batchEnd),
  ]);

  return { lastLegacyId: batchEnd, migrated: batchCount, complete: false };
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

    const period = previousDay(now);
    let lastRollupKey = state?.last_rollup_key || null;
    let lastCleanupAt = Number(state?.last_cleanup_at || 0);
    let legacyBackfillId = Number(state?.legacy_backfill_id || 0);
    let rolledUp = false;
    let cleaned = false;

    if (lastRollupKey !== period.key) {
      const dailyWritten = await rollupDaily(db, period, now);
      if (dailyWritten) {
        await rollupFromDaily(db, 'sh_weekly_summary', weeklyRange(period.key), now);
        await rollupFromDaily(db, 'sh_monthly_summary', monthlyRange(period.key), now);
        lastRollupKey = period.key;
        rolledUp = true;
      }
    }

    if (now - lastCleanupAt >= HOUR_MS) {
      await cleanup(db, now);
      lastCleanupAt = now;
      cleaned = true;
    }

    const legacyBackfill = await backfillLegacySamples(db, legacyBackfillId);
    legacyBackfillId = legacyBackfill.lastLegacyId;

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
      legacyBackfill,
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
