import {
  minuteFactContextDeleteStatement,
  minuteFactContextUpsertStatement,
  minuteFactStatement,
  totalMemberDailyStatement,
} from './minute-facts-normalize.js';

const DASHBOARD_BUCKET_MS = 5 * 60_000;

function contextPresent(fact) {
  return fact.queue_revision_id != null
    || Number(fact.queue_available || 0) !== 0
    || fact.queue_position != null
    || fact.broadcast_session_id == null;
}

export function dashboardHistoryRollupStatement(db, fact) {
  if (Number(fact?.source_code) !== 1) return db.prepare('SELECT 1 WHERE 0');
  const minuteAt = Number(fact?.minute_at);
  const bucketAt = Math.floor(minuteAt / DASHBOARD_BUCKET_MS) * DASHBOARD_BUCKET_MS;
  return db.prepare(`WITH source_points AS (
      SELECT f.id,f.channel_id,f.minute_at,f.observed_at,
        f.listener_count,f.online_member_count,f.total_member_count,
        f.reported_total_listens AS total_listens,
        f.reported_current_stream_count AS current_stream_count,
        COALESCE((
          SELECT SUM(COALESCE(recent.comment_count,0))
          FROM sh_minute_facts AS recent
            INDEXED BY idx_sh_minute_facts_source_channel_minute_desc
          WHERE recent.source_code=1
            AND recent.channel_id=f.channel_id
            AND recent.minute_at>=f.minute_at-60000
            AND recent.minute_at<=f.minute_at
        ),0) AS comment_velocity
      FROM sh_minute_facts AS f
      WHERE f.source_code=1
        AND f.channel_id=?
        AND f.minute_at>=?
        AND f.minute_at<?
    ), bucket_points AS (
      SELECT * FROM source_points WHERE minute_at>=?
    ), ranked AS (
      SELECT bucket_points.*,
        MAX(comment_velocity) OVER () AS comment_velocity_max,
        ROW_NUMBER() OVER (ORDER BY minute_at DESC,id DESC) AS bucket_rank
      FROM bucket_points
    )
    INSERT INTO sh_dashboard_history_5m(
      channel_id,bucket_at,fact_id,minute_at,observed_at,
      listener_count,online_member_count,total_member_count,total_listens,
      current_stream_count,comment_velocity
    )
    SELECT channel_id,?,id,minute_at,observed_at,
      listener_count,online_member_count,total_member_count,total_listens,
      current_stream_count,comment_velocity_max
    FROM ranked WHERE bucket_rank=1
    ON CONFLICT(channel_id,bucket_at) DO UPDATE SET
      fact_id=excluded.fact_id,
      minute_at=excluded.minute_at,
      observed_at=excluded.observed_at,
      listener_count=excluded.listener_count,
      online_member_count=excluded.online_member_count,
      total_member_count=excluded.total_member_count,
      total_listens=excluded.total_listens,
      current_stream_count=excluded.current_stream_count,
      comment_velocity=excluded.comment_velocity`)
    .bind(
      fact.channel_id,
      bucketAt - 60_000,
      bucketAt + DASHBOARD_BUCKET_MS,
      bucketAt,
      bucketAt,
    );
}

export function minuteFactStatements(db, fact) {
  return [
    minuteFactStatement(db, fact),
    dashboardHistoryRollupStatement(db, fact),
    totalMemberDailyStatement(db, fact),
    contextPresent(fact)
      ? minuteFactContextUpsertStatement(db, fact)
      : minuteFactContextDeleteStatement(db, fact),
  ];
}
