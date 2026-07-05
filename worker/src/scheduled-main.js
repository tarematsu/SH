import mainApp, { withD1WriteThrottling } from './main.js';
import app from './official-news-reconcile-entry.js';
import { runCloudHostMonitor } from './cloud-host-monitor.js';
import { runCloudWeeklyLeaderboard } from './cloud-weekly-leaderboard.js';
import { resetCollectionFlight } from './index.js';

const PRIMARY_LEASE_SCOPE = 'stationhead-primary';
const PRIMARY_SUCCESS_GRACE_MS = 5_000;
const DEFAULT_PRIMARY_WATCHDOG_MS = 55_000;
const MIN_PRIMARY_WATCHDOG_MS = 10_000;
const MAX_PRIMARY_WATCHDOG_MS = 55_000;
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

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function streamGoalPredictionIntervalMs(env = {}) {
  const configured = Number(env.STREAM_GOAL_PREDICTION_INTERVAL_MS ?? DEFAULT_PREDICTION_INTERVAL_MS);
  if (!Number.isFinite(configured)) return DEFAULT_PREDICTION_INTERVAL_MS;
  return Math.max(
    MIN_PREDICTION_INTERVAL_MS,
    Math.min(MAX_PREDICTION_INTERVAL_MS, Math.trunc(configured)),
  );
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
  ) {
    return base;
  }

  const covariance = xyMean - xMean * yMean;
  const variance = xxMean - xMean * xMean;
  if (!Number.isFinite(variance) || variance <= 0) return base;

  const ratePerHour = covariance / variance;
  if (!Number.isFinite(ratePerHour) || ratePerHour <= 0) return base;

  return {
    ...base,
    eta: remaining === 0
      ? generatedAt
      : Math.round(generatedAt + (remaining / ratePerHour) * 3600000),
    ratePerHour,
  };
}

function predictionFailureMessage(error) {
  return String(error?.message || error).slice(0, 1000);
}

function predictionTableMissing(error) {
  return /no such table:\s*sh_stream_goal_prediction_state/i.test(
    String(error?.message || error),
  );
}

export async function runStreamGoalPrediction(env, now = Date.now()) {
  if (!env?.DB) return { skipped: true, reason: 'db-binding-missing' };

  const intervalMs = streamGoalPredictionIntervalMs(env);
  let claimed;
  try {
    claimed = await env.DB.prepare(CLAIM_STREAM_GOAL_PREDICTION_SQL)
      .bind(PREDICTION_STATE_ID, now + PREDICTION_CLAIM_LEASE_MS, now, now)
      .first();
  } catch (error) {
    if (predictionTableMissing(error)) {
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
    await env.DB.prepare(SAVE_STREAM_GOAL_PREDICTION_SQL)
      .bind(
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
      )
      .run();

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
    await env.DB.prepare(FAIL_STREAM_GOAL_PREDICTION_SQL)
      .bind(
        now + PREDICTION_RETRY_MS,
        predictionFailureMessage(error),
        now,
        PREDICTION_STATE_ID,
      )
      .run()
      .catch(() => {});
    throw error;
  }
}

const DEFAULT_AUXILIARY_RUNNERS = Object.freeze({
  weekly: runCloudWeeklyLeaderboard,
  prediction: runStreamGoalPrediction,
  host: runCloudHostMonitor,
});

let primaryScheduledFlight = null;

function primaryWatchdogMs(env = {}) {
  const configured = Number(env.PRIMARY_COLLECTION_WATCHDOG_MS ?? DEFAULT_PRIMARY_WATCHDOG_MS);
  if (!Number.isFinite(configured)) return DEFAULT_PRIMARY_WATCHDOG_MS;
  return Math.max(MIN_PRIMARY_WATCHDOG_MS, Math.min(MAX_PRIMARY_WATCHDOG_MS, configured));
}

export class PrimaryCollectionTimeoutError extends Error {
  constructor(timeoutMs, cron) {
    super(`Primary Stationhead collection timed out after ${timeoutMs}ms (${cron || 'scheduled'})`);
    this.name = 'PrimaryCollectionTimeoutError';
    this.code = 'PRIMARY_COLLECTION_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

function reportAuxiliaryFailures(tasks, results) {
  for (const [index, result] of results.entries()) {
    if (result.status !== 'rejected') continue;
    console.error(JSON.stringify({
      event: tasks[index]?.failureEvent || 'scheduled_auxiliary_failed',
      error: String(result.reason?.message || result.reason),
    }));
  }
}

function startAuxiliaryOnce(flight, env, includeHost, runners) {
  if (!flight.weekly) flight.weekly = Promise.resolve().then(() => runners.weekly(env));
  if (!flight.prediction) {
    const predictionRunner = runners.prediction || runStreamGoalPrediction;
    flight.prediction = Promise.resolve().then(() => predictionRunner(env));
  }
  if (includeHost && !flight.host) {
    flight.host = Promise.resolve().then(() => runners.host(env));
  }
  const tasks = [
    { failureEvent: 'cloud_weekly_leaderboard_failed', promise: flight.weekly },
    { failureEvent: 'stream_goal_prediction_failed', promise: flight.prediction },
    ...(flight.host
      ? [{ failureEvent: 'cloud_host_monitor_failed', promise: flight.host }]
      : []),
  ];
  flight.auxiliary = Promise.allSettled(tasks.map((task) => task.promise)).then((results) => {
    reportAuxiliaryFailures(tasks, results);
    return results;
  });
  return flight.auxiliary;
}

function releasePrimaryFlight(flight) {
  if (primaryScheduledFlight === flight) primaryScheduledFlight = null;
}

function ensurePrimaryScheduledFlight(controller, env, ctx, scheduled, runners) {
  if (primaryScheduledFlight) return primaryScheduledFlight;

  let signalTimeout;
  const timeoutOutcome = new Promise((resolve) => {
    signalTimeout = () => resolve({ failed: true });
  });
  const flight = {
    primary: Promise.resolve().then(() => scheduled(controller, env, ctx)),
    weekly: null,
    prediction: null,
    host: null,
    auxiliary: null,
    lifecycle: null,
    signalTimeout,
  };
  primaryScheduledFlight = flight;

  const primaryOutcome = flight.primary.then(
    () => {
      releasePrimaryFlight(flight);
      return { failed: false };
    },
    () => {
      releasePrimaryFlight(flight);
      return { failed: true };
    },
  );
  flight.lifecycle = Promise.race([primaryOutcome, timeoutOutcome])
    .then(({ failed }) => startAuxiliaryOnce(flight, env, failed, runners));
  ctx?.waitUntil?.(flight.lifecycle);
  return flight;
}

function abandonPrimaryFlight(flight, resetCollector) {
  releasePrimaryFlight(flight);
  try {
    resetCollector();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'collector_flight_reset_failed',
      error: String(error?.message || error),
    }));
  }
  flight.signalTimeout?.();
}

export function resetPrimaryScheduledFlightForTests() {
  primaryScheduledFlight = null;
  resetCollectionFlight();
}

export async function runPrimaryScheduled(
  controller,
  env,
  ctx,
  scheduled = app.scheduled.bind(app),
  timeoutOverride = null,
  options = {},
) {
  const timeoutMs = timeoutOverride ?? primaryWatchdogMs(env);
  const runners = options.auxiliaryRunners || DEFAULT_AUXILIARY_RUNNERS;
  const resetCollector = options.resetCollectionFlight || resetCollectionFlight;
  const flight = ensurePrimaryScheduledFlight(controller, env, ctx, scheduled, runners);
  let timeoutId = null;

  try {
    return await Promise.race([
      flight.primary,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          abandonPrimaryFlight(flight, resetCollector);
          reject(new PrimaryCollectionTimeoutError(timeoutMs, controller?.cron));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
}

export async function expireLeaseWhenPrimaryFailed(env, runStartedAt) {
  if (!env?.DB) return;
  try {
    const state = await env.DB.prepare(`SELECT last_success_at,last_error
      FROM sh_worker_collector_state WHERE id='stationhead'`).first();
    const lastSuccessAt = Number(state?.last_success_at || 0);
    if (lastSuccessAt >= runStartedAt - PRIMARY_SUCCESS_GRACE_MS) return;

    await env.DB.prepare(`UPDATE sh_collector_leases
      SET lease_until=?,updated_at=?,metadata_json=?
      WHERE scope=? AND holder_kind='cloud'`)
      .bind(
        runStartedAt - 1,
        Date.now(),
        JSON.stringify({
          cron: 'every-minute',
          healthy: false,
          reason: 'primary_collection_failed',
          last_success_at: lastSuccessAt || null,
          last_error: state?.last_error || null,
        }),
        PRIMARY_LEASE_SCOPE,
      ).run();
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || ''))) throw error;
  }
}

export async function runPrimaryCycle(
  controller,
  collectionEnv,
  leaseEnv,
  ctx,
  options = {},
) {
  const runStartedAt = options.runStartedAt ?? Date.now();
  const runPrimary = options.runPrimary || runPrimaryScheduled;
  const expireLease = options.expireLease || expireLeaseWhenPrimaryFailed;
  try {
    return await runPrimary(
      controller,
      collectionEnv,
      ctx,
      options.scheduled || app.scheduled.bind(app),
      options.timeoutOverride ?? null,
      {
        auxiliaryRunners: options.auxiliaryRunners,
        resetCollectionFlight: options.resetCollectionFlight,
      },
    );
  } catch (primaryError) {
    try {
      await expireLease(leaseEnv, runStartedAt);
    } catch (leaseError) {
      console.error(JSON.stringify({
        event: 'collector_lease_expiry_failed',
        error: String(leaseError?.message || leaseError),
      }));
    }
    throw primaryError;
  }
}

export default {
  async scheduled(controller, env, ctx) {
    return runPrimaryCycle(controller, withD1WriteThrottling(env), env, ctx);
  },

  fetch(request, env, ctx) {
    return mainApp.fetch(request, env, ctx);
  },
};
