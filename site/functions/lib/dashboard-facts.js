// Minute facts are a downstream read model.  The buddies collector is the
// real-time source and can legitimately be ahead while the minute worker is
// draining its backlog.  Keep the dashboard threshold aligned with the
// recovery endpoint so a normal downstream lag is not rendered as a stopped
// collector.
export const FACTS_FRESH_MS = 10 * 60 * 1000;

function commentVelocitySql(alias = 'f') {
  return `COALESCE((
    SELECT SUM(recent.comment_count)
    FROM sh_minute_facts AS recent
    WHERE recent.source_code=1
      AND recent.channel_id=${alias}.channel_id
      AND recent.minute_at>=${alias}.minute_at-60000
      AND recent.minute_at<=${alias}.minute_at
  ),0)`;
}

export const FACTS_LATEST_SQL = `SELECT
  f.id,f.minute_at,f.observed_at,f.channel_id,
  f.is_broadcasting,f.listener_count,f.online_member_count,
  COALESCE((SELECT d.last_total_member_count FROM sh_total_member_daily d
    WHERE d.channel_id=f.channel_id AND d.day_at=(f.observed_at/86400000)*86400000
      AND d.host_key IN (0,COALESCE(c.host_id,0))
    ORDER BY d.host_key DESC,d.last_observed_at DESC LIMIT 1),f.total_member_count)
    AS total_member_count,f.guest_count,
  f.reported_total_listens AS total_listens,
  f.reported_current_stream_count AS current_stream_count,
  f.is_paused,${commentVelocitySql('f')} AS comment_velocity,
  c.station_id,c.host_id,c.broadcast_start_time,c.queue_revision_id,
  c.queue_id,c.queue_start_time,c.queue_track_count,c.queue_available,
  h.stationhead_account_id AS host_account_id,h.current_handle AS host_handle
FROM sh_minute_facts AS f
LEFT JOIN sh_minute_fact_context AS c ON c.fact_id=f.id
LEFT JOIN sh_hosts AS h ON h.id=c.host_id
WHERE f.source_code=1
ORDER BY f.minute_at DESC,f.id DESC
LIMIT 1`;

function factsHistorySql(whereClause) {
  return `WITH latest_channel AS (
    SELECT channel_id FROM sh_minute_facts WHERE source_code=1 ORDER BY minute_at DESC,id DESC LIMIT 1
  ), points AS (
    SELECT f.id,f.minute_at,f.observed_at,f.listener_count,f.online_member_count,
      COALESCE((SELECT d.last_total_member_count FROM sh_total_member_daily d
        WHERE d.channel_id=f.channel_id AND d.day_at=(f.observed_at/86400000)*86400000
        ORDER BY d.last_observed_at DESC,d.host_key LIMIT 1),f.total_member_count)
        AS total_member_count,f.reported_total_listens AS total_listens,
      ${commentVelocitySql('f')} AS comment_velocity
    FROM sh_minute_facts AS f
    WHERE f.source_code=1
      AND f.channel_id=(SELECT channel_id FROM latest_channel)
      AND ${whereClause}
  ), ranked AS (
    SELECT *,
      MAX(comment_velocity) OVER (
        PARTITION BY CAST(minute_at/300000 AS INTEGER)
      ) AS comment_velocity_max,
      ROW_NUMBER() OVER (
        PARTITION BY CAST(minute_at/300000 AS INTEGER)
        ORDER BY minute_at DESC,id DESC
      ) AS rn
    FROM points
  )
  SELECT observed_at,listener_count,online_member_count,total_member_count,
    total_listens,comment_velocity_max AS comment_velocity
  FROM ranked WHERE rn=1 ORDER BY observed_at ASC LIMIT 300`;
}

function factsHistory24hSql() {
  return `WITH latest_channel AS (
    SELECT channel_id FROM sh_minute_facts WHERE source_code=1 ORDER BY minute_at DESC,id DESC LIMIT 1
  ), bounds AS (
    SELECT unixepoch('now','-24 hours')*1000 AS from_at
  ), daily_ranked AS (
    SELECT d.channel_id,d.day_at,d.last_total_member_count,
      ROW_NUMBER() OVER (
        PARTITION BY d.channel_id,d.day_at
        ORDER BY d.last_observed_at DESC,d.host_key ASC
      ) AS daily_rank
    FROM sh_total_member_daily AS d
    WHERE d.channel_id=(SELECT channel_id FROM latest_channel)
      AND d.day_at>=((SELECT from_at FROM bounds)/86400000)*86400000
  ), comment_points AS (
    SELECT f.id,f.channel_id,f.minute_at,f.observed_at,
      f.listener_count,f.online_member_count,f.total_member_count,
      f.reported_total_listens AS total_listens,
      COALESCE(SUM(COALESCE(f.comment_count,0)) OVER (
        PARTITION BY f.channel_id
        ORDER BY f.minute_at
        RANGE BETWEEN 60000 PRECEDING AND CURRENT ROW
      ),0) AS comment_velocity
    FROM sh_minute_facts AS f
    WHERE f.source_code=1
      AND f.channel_id=(SELECT channel_id FROM latest_channel)
      AND f.minute_at>=(SELECT from_at FROM bounds)-60000
  ), points AS (
    SELECT f.id,f.minute_at,f.observed_at,f.listener_count,f.online_member_count,
      COALESCE(d.last_total_member_count,f.total_member_count) AS total_member_count,
      f.total_listens,f.comment_velocity
    FROM comment_points AS f
    LEFT JOIN daily_ranked AS d
      ON d.channel_id=f.channel_id
        AND d.day_at=(f.observed_at/86400000)*86400000
        AND d.daily_rank=1
    WHERE f.minute_at>=(SELECT from_at FROM bounds)
  ), ranked AS (
    SELECT *,
      MAX(comment_velocity) OVER (
        PARTITION BY CAST(minute_at/300000 AS INTEGER)
      ) AS comment_velocity_max,
      ROW_NUMBER() OVER (
        PARTITION BY CAST(minute_at/300000 AS INTEGER)
        ORDER BY minute_at DESC,id DESC
      ) AS rn
    FROM points
  )
  SELECT observed_at,listener_count,online_member_count,total_member_count,
    total_listens,comment_velocity_max AS comment_velocity
  FROM ranked WHERE rn=1 ORDER BY observed_at ASC LIMIT 300`;
}

export const FACTS_HISTORY_24H_SQL = factsHistory24hSql();
export const FACTS_HISTORY_SINCE_SQL = factsHistorySql('f.observed_at>?');

export const FACTS_PREDICTION_24H_SQL = `WITH latest_channel AS (
  SELECT channel_id FROM sh_minute_facts WHERE source_code=1 ORDER BY minute_at DESC,id DESC LIMIT 1
), ranked AS (
  SELECT id,minute_at AS observed_at,reported_current_stream_count AS current_stream_count,
    ROW_NUMBER() OVER (
      PARTITION BY CAST(minute_at/300000 AS INTEGER)
      ORDER BY minute_at DESC,id DESC
    ) AS bucket_rank
  FROM sh_minute_facts
  WHERE source_code=1
    AND channel_id=(SELECT channel_id FROM latest_channel)
    AND minute_at >= (unixepoch('now','-24 hours')*1000)
    AND reported_current_stream_count IS NOT NULL
), points AS (
  SELECT observed_at,CAST(current_stream_count AS REAL) AS y,
    (observed_at-MIN(observed_at) OVER ())/3600000.0 AS x,
    ROW_NUMBER() OVER (ORDER BY observed_at DESC,id DESC) AS latest_rank
  FROM ranked WHERE bucket_rank=1
)
SELECT COUNT(*) AS sample_count,MIN(observed_at) AS first_t,
  MAX(observed_at) AS last_t,AVG(x) AS x_mean,AVG(y) AS y_mean,
  AVG(x*y) AS xy_mean,AVG(x*x) AS xx_mean,
  MAX(CASE WHEN latest_rank=1 THEN y END) AS latest_y
FROM points`;

export function factsAreFresh(latest, now = Date.now(), staleAfterMs = FACTS_FRESH_MS) {
  const observedAt = Number(latest?.observed_at);
  return Number.isFinite(observedAt) && observedAt > 0 && now - observedAt <= staleAfterMs;
}

export function mergeFactsLatest(snapshot, fact) {
  if (!fact) return snapshot || null;
  const merged = { ...(snapshot || {}) };
  for (const field of [
    'observed_at',
    'channel_id',
    'station_id',
    'is_broadcasting',
    'listener_count',
    'online_member_count',
    'total_member_count',
    'guest_count',
    'total_listens',
    'current_stream_count',
    'host_account_id',
    'host_handle',
    'broadcast_start_time',
    'comment_velocity',
  ]) {
    if (fact[field] !== undefined) merged[field] = fact[field];
  }
  return merged;
}

export async function loadFactsDashboard(db, { since = 0, includeHistory = true } = {}) {
  const initial = since <= 0;
  const historyStatement = !includeHistory
    ? null
    : initial
      ? db.prepare(FACTS_HISTORY_24H_SQL)
      : db.prepare(FACTS_HISTORY_SINCE_SQL).bind(since);
  const predictionStatement = initial && includeHistory
    ? null
    : db.prepare(FACTS_PREDICTION_24H_SQL);
  const [latest, historyResult, predictionResult] = await Promise.all([
    db.prepare(FACTS_LATEST_SQL).first(),
    historyStatement ? historyStatement.all() : Promise.resolve({ results: [] }),
    predictionStatement ? predictionStatement.first() : Promise.resolve(null),
  ]);
  return {
    latest,
    history: historyResult?.results || [],
    prediction: predictionResult,
  };
}

export async function loadFactsBaseline(db, metricColumn, hostId, start, end) {
  const column = {
    total_member_count: 'total_member_count',
    total_listens: 'reported_total_listens',
  }[metricColumn];
  if (!column) throw new Error(`unsupported facts metric: ${metricColumn}`);
  if (metricColumn === 'total_member_count') {
    const row = await db.prepare(`SELECT d.last_observed_at AS observed_at,
        d.last_total_member_count AS total_member_count
      FROM sh_total_member_daily d
      WHERE d.day_at>=? AND d.day_at<?
        AND (? IS NULL OR d.host_key IN (0,?))
      ORDER BY d.last_observed_at DESC,d.day_at DESC LIMIT 1`)
      .bind(start, end, hostId ?? null, hostId ?? 0)
      .first();
    return row || null;
  }
  const row = await db.prepare(`SELECT f.observed_at,f.${column} AS ${metricColumn}
    FROM sh_minute_facts AS f
    LEFT JOIN sh_minute_fact_context AS c ON c.fact_id=f.id
    WHERE f.minute_at>=? AND f.minute_at<?
      AND f.source_code=1
      AND (? IS NULL OR c.host_id=?)
    ORDER BY f.observed_at DESC,f.id DESC LIMIT 1`)
    .bind(start, end, hostId ?? null, hostId ?? null)
    .first();
  return row || null;
}
