import { finiteNumber as finite } from './shared.js';

const PREDICTION_STATE_ID = 'stream-goal-24h';
const PREDICTION_DAY_MS = 24 * 60 * 60_000;
const DEFAULT_PREDICTION_INTERVAL_MS = 30 * 60_000;
const MIN_PREDICTION_INTERVAL_MS = 5 * 60_000;
const MAX_PREDICTION_INTERVAL_MS = 24 * 60 * 60_000;
const PREDICTION_CLAIM_LEASE_MS = 5 * 60_000;
const PREDICTION_RETRY_MS = 5 * 60_000;

export const CLAIM_STREAM_GOAL_PREDICTION_SQL = `INSERT INTO sh_stream_goal_prediction_state (
  id,generated_at,sample_count,next_refresh_at,last_error,updated_at
) VALUES (?,0,0,?,NULL,?)
ON CONFLICT(id) DO UPDATE SET
  next_refresh_at=excluded.next_refresh_at,
  last_error=NULL,
  updated_at=excluded.updated_at
WHERE sh_stream_goal_prediction_state.next_refresh_at<=?
RETURNING generated_at`;

export const STREAM_GOAL_PREDICTION_AGGREGATE_SQL = `WITH ranked AS (
  SELECT id,observed_at,stream_goal,
    COALESCE(validated_stream_count,current_stream_count,total_listens) AS stream_value,
    ROW_NUMBER() OVER (
      PARTITION BY CAST(observed_at/300000 AS INTEGER)
      ORDER BY observed_at DESC,id DESC
    ) AS bucket_rank
  FROM sh_channel_snapshots
  WHERE observed_at>=?
    AND COALESCE(validated_stream_count,current_stream_count,total_listens) IS NOT NULL
), points AS (
  SELECT id,observed_at,
    CAST(stream_value AS REAL) AS y,
    (observed_at-MIN(observed_at) OVER())/3600000.0 AS x,
    ROW_NUMBER() OVER (ORDER BY observed_at DESC,id DESC) AS latest_rank
  FROM ranked
  WHERE bucket_rank=1
), latest AS (
  SELECT observed_at,stream_goal,
    COALESCE(validated_stream_count,current_stream_count,total_listens) AS stream_value
  FROM sh_channel_snapshots
  ORDER BY observed_at DESC,id DESC
  LIMIT 1
)
SELECT COUNT(*) AS sample_count,
  MIN(observed_at) AS first_t,
  MAX(observed_at) AS last_t,
  AVG(x) AS x_mean,
  AVG(y) AS y_mean,
  AVG(x*y) AS xy_mean,
  AVG(x*x) AS xx_mean,
  MAX(CASE WHEN latest_rank=1 THEN y END) AS latest_y,
  (SELECT observed_at FROM latest) AS source_observed_at,
  (SELECT stream_goal FROM latest) AS goal,
  (SELECT stream_value FROM latest) AS current_value
FROM points`;

const SAVE_STREAM_GOAL_PREDICTION_SQL = `UPDATE sh_stream_goal_prediction_state SET
  generated_at=?,source_observed_at=?,goal=?,eta=?,rate_per_hour=?,remaining=?,
  sample_count=?,span_hours=?,next_refresh_at=?,last_error=NULL,updated_at=?
WHERE id=?`;

const FAIL_STREAM_GOAL_PREDICTION_SQL = `UPDATE sh_stream_goal_prediction_state SET
  next_refresh_at=?,last_error=?,updated_at=?
WHERE id=?`;

export function streamGoalPredictionIntervalMs(env = {}) {
  const configured = Number(env.STREAM_GOAL_PREDICTION_INTERVAL_MS ?? DEFAULT_PREDICTION_INTERVAL_MS);
  return Number.isFinite(configured)
    ? Math.max(MIN_PREDICTION_INTERVAL_MS, Math.min(MAX_PREDICTION_INTERVAL_MS, Math.trunc(configured)))
    : DEFAULT_PREDICTION_INTERVAL_MS;
}

export function predictionFromAggregate(row, generatedAt = Date.now()) {
  const sampleCount = finite(row?.sample_count) ?? 0;
  const firstT = finite(row?.first_t);
  const lastT = finite(row?.last_t);
  const xMean = finite(row?.x_mean);
  const yMean = finite(row?.y_mean);
  const xyMean = finite(row?.xy_mean);
  const xxMean = finite(row?.xx_mean);
  const latest = finite(row?.current_value ?? row?.latest_y);
  const goal = finite(row?.goal);
  const sourceObservedAt = finite(row?.source_observed_at ?? row?.last_t);
  const spanMs = firstT == null || lastT == null ? 0 : Math.max(0, lastT - firstT);
  const spanHours = spanMs / 3600000;
  const remaining = goal == null || latest == null ? null : Math.max(0, Math.round(goal - latest));
  const base = {
    generatedAt,
    sourceObservedAt,
    goal,
    eta: null,
    ratePerHour: null,
    remaining,
    sampleCount: Math.max(0, Math.trunc(sampleCount)),
    spanHours,
  };

  if (
    goal == null || goal <= 0 || latest == null || sampleCount < 5 || spanMs < 15 * 60_000
    || [xMean, yMean, xyMean, xxMean].some((value) => value == null)
  ) return base;

  const variance = xxMean - xMean * xMean;
  const ratePerHour = (xyMean - xMean * yMean) / variance;
  if (!Number.isFinite(variance) || variance <= 0 || !Number.isFinite(ratePerHour) || ratePerHour <= 0) return base;

  return {
    ...base,
    eta: remaining === 0 ? generatedAt : Math.round(generatedAt + (remaining / ratePerHour) * 3600000),
    ratePerHour,
  };
}

function savePredictionStatement(env, prediction, now, intervalMs) {
  return env.OTHER_DB.prepare(SAVE_STREAM_GOAL_PREDICTION_SQL).bind(
    prediction.generatedAt,
    prediction.sourceObservedAt,
    prediction.goal,
    prediction.eta,
    prediction.ratePerHour,
    prediction.remaining,
    prediction.sampleCount,
    prediction.spanHours,
    now + intervalMs,
    now,
    PREDICTION_STATE_ID,
  );
}

export async function runStreamGoalPrediction(env, now = Date.now()) {
  if (!env?.DB || !env?.OTHER_DB) return { skipped: true, reason: 'db-binding-missing' };

  const intervalMs = streamGoalPredictionIntervalMs(env);
  let claimed;
  try {
    claimed = await env.OTHER_DB.prepare(CLAIM_STREAM_GOAL_PREDICTION_SQL)
      .bind(PREDICTION_STATE_ID, now + PREDICTION_CLAIM_LEASE_MS, now, now)
      .first();
  } catch (error) {
    if (/no such table:\s*sh_stream_goal_prediction_state/i.test(String(error?.message || error))) {
      return { skipped: true, reason: 'prediction-state-setup-required' };
    }
    throw error;
  }

  if (!claimed) return { skipped: true, reason: 'not-due' };

  try {
    const aggregate = await env.DB.prepare(STREAM_GOAL_PREDICTION_AGGREGATE_SQL)
      .bind(now - PREDICTION_DAY_MS)
      .first();
    const prediction = predictionFromAggregate(aggregate, now);
    await savePredictionStatement(env, prediction, now, intervalMs).run();

    console.log(JSON.stringify({
      event: 'stream_goal_prediction_refreshed',
      generated_at: prediction.generatedAt,
      sample_count: prediction.sampleCount,
      rate_per_hour: prediction.ratePerHour,
      eta: prediction.eta,
      next_refresh_at: now + intervalMs,
    }));
    return { skipped: false, ...prediction, nextRefreshAt: now + intervalMs };
  } catch (error) {
    await env.OTHER_DB.prepare(FAIL_STREAM_GOAL_PREDICTION_SQL)
      .bind(now + PREDICTION_RETRY_MS, String(error?.message || error).slice(0, 1000), now, PREDICTION_STATE_ID)
      .run()
      .catch(() => {});
    throw error;
  }
}
