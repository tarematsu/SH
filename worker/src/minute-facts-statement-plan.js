import {
  minuteFactContextDeleteStatement,
  minuteFactContextUpsertStatement,
  minuteFactStatement,
} from './minute-facts-normalize.js';
import { totalMemberDailyChangeStatement } from './minute-facts-daily-state.js';

const DASHBOARD_BUCKET_MS = 5 * 60_000;

function contextPresent(fact) {
  return fact.queue_revision_id != null
    || Number(fact.queue_available || 0) !== 0
    || fact.queue_position != null
    || fact.broadcast_session_id == null;
}

function completedDashboardBucket(minuteAt) {
  if (!Number.isFinite(minuteAt)) return null;
  return Math.floor(minuteAt / DASHBOARD_BUCKET_MS) * DASHBOARD_BUCKET_MS - DASHBOARD_BUCKET_MS;
}

export function dashboardHistoryRollupStatement(db, fact) {
  if (Number(fact?.source_code) !== 1) return db.prepare('SELECT 1 WHERE 0');
  const bucketAt = completedDashboardBucket(Number(fact?.minute_at));
  if (bucketAt == null) return db.prepare('SELECT 1 WHERE 0');
  const bucketEnd = bucketAt + DASHBOARD_BUCKET_MS;
  return db.prepare(`WITH bucket_facts AS (
      SELECT f.id,f.channel_id,f.minute_at,f.observed_at,
        f.listener_count,f.online_member_count,f.total_member_count,
        f.reported_total_listens AS total_listens,
        f.reported_current_stream_count AS current_stream_count,
        COALESCE(f.comment_count,0) AS comment_count
      FROM sh_minute_facts AS f
        INDEXED BY idx_sh_minute_facts_source_channel_minute_desc
      WHERE f.source_code=1 AND f.channel_id=?
        AND f.minute_at>=? AND f.minute_at<?
    ), latest AS (
      SELECT * FROM bucket_facts
      ORDER BY minute_at DESC,id DESC
      LIMIT 1
    ), point AS (
      SELECT latest.*,
        COALESCE((
          SELECT MAX(f.comment_count+COALESCE((
            SELECT COALESCE(previous.comment_count,0)
            FROM sh_minute_facts AS previous
              INDEXED BY idx_sh_minute_facts_source_channel_minute_desc
            WHERE previous.source_code=1
              AND previous.channel_id=f.channel_id
              AND previous.minute_at<f.minute_at
              AND previous.minute_at>=f.minute_at-60000
            ORDER BY previous.minute_at DESC,previous.id DESC
            LIMIT 1
          ),0))
          FROM bucket_facts f
        ),0) AS comment_velocity
      FROM latest
    )
    INSERT INTO sh_dashboard_history_5m(
      channel_id,bucket_at,fact_id,minute_at,observed_at,
      listener_count,online_member_count,total_member_count,total_listens,
      current_stream_count,comment_velocity
    )
    SELECT channel_id,?,id,minute_at,observed_at,
      listener_count,online_member_count,total_member_count,total_listens,
      current_stream_count,comment_velocity
    FROM point
    WHERE TRUE
    ON CONFLICT(channel_id,bucket_at) DO UPDATE SET
      fact_id=excluded.fact_id,
      minute_at=excluded.minute_at,
      observed_at=excluded.observed_at,
      listener_count=excluded.listener_count,
      online_member_count=excluded.online_member_count,
      total_member_count=excluded.total_member_count,
      total_listens=excluded.total_listens,
      current_stream_count=excluded.current_stream_count,
      comment_velocity=MAX(sh_dashboard_history_5m.comment_velocity,excluded.comment_velocity)
    WHERE excluded.minute_at>sh_dashboard_history_5m.minute_at
      OR (excluded.minute_at=sh_dashboard_history_5m.minute_at AND (
        excluded.fact_id IS NOT sh_dashboard_history_5m.fact_id
        OR excluded.observed_at IS NOT sh_dashboard_history_5m.observed_at
        OR excluded.listener_count IS NOT sh_dashboard_history_5m.listener_count
        OR excluded.online_member_count IS NOT sh_dashboard_history_5m.online_member_count
        OR excluded.total_member_count IS NOT sh_dashboard_history_5m.total_member_count
        OR excluded.total_listens IS NOT sh_dashboard_history_5m.total_listens
        OR excluded.current_stream_count IS NOT sh_dashboard_history_5m.current_stream_count
        OR excluded.comment_velocity>sh_dashboard_history_5m.comment_velocity
      ))`)
    .bind(fact.channel_id, bucketAt, bucketEnd, bucketAt);
}

export function minuteFactStatements(db, fact) {
  return [
    minuteFactStatement(db, fact),
    dashboardHistoryRollupStatement(db, fact),
    totalMemberDailyChangeStatement(db, fact),
    contextPresent(fact)
      ? minuteFactContextUpsertStatement(db, fact)
      : minuteFactContextDeleteStatement(db, fact),
  ];
}
