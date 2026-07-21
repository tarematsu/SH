import './fetch-guard.js';

export const OTHER_MONITOR_CRON = '*/5 * * * *';
const MINUTE_MS = 60_000;
const OTHER_CRON_SUCCESS_CHECKPOINT_MS = 10 * MINUTE_MS;
const EMPTY_DEPENDENCIES = Object.freeze({});
const OTHER_SUCCESS_MESSAGE = 'other-monitor-success';
const OTHER_CRON_SUCCESS_SQL = `INSERT INTO sh_collector_status (
    collector_id,status,last_attempt_at,last_success_at,last_error,
    failure_code,failure_stage,failure_summary,failure_hint,tracks,changed,updated_at
  ) VALUES ('other-cron','ok',?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?)
  ON CONFLICT(collector_id) DO UPDATE SET
    status='ok',last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,
    last_error=NULL,failure_code=NULL,failure_stage=NULL,failure_summary=NULL,failure_hint=NULL,
    updated_at=excluded.updated_at
  WHERE sh_collector_status.last_success_at IS NULL
    OR excluded.last_success_at >= sh_collector_status.last_success_at + ${OTHER_CRON_SUCCESS_CHECKPOINT_MS}`;

let predictionModulePromise;

function loadPredictionModule() {
  predictionModulePromise ||= import('./stream-goal-prediction.js');
  return predictionModulePromise;
}

function scheduledTimestamp(controller, fallback = Date.now()) {
  const value = Number(controller?.scheduledTime);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function otherMonitorTask(now) {
  const minute = Math.floor(Number(now) / MINUTE_MS) % 60;
  return minute === 10 || minute === 40 ? 'prediction' : 'idle';
}

async function recordSuccess(env, at) {
  if (!env?.OTHER_DB?.prepare) return false;
  try {
    await env.OTHER_DB.prepare(OTHER_CRON_SUCCESS_SQL).bind(at, at, at).run();
    return true;
  } catch (error) {
    if (/no such table/i.test(String(error?.message || error))) return false;
    throw error;
  }
}

async function recordFailure(env, error, at) {
  if (!env?.OTHER_DB?.prepare) return false;
  const message = String(error?.message || error).slice(0, 800);
  try {
    await env.OTHER_DB.prepare(`INSERT INTO sh_collector_status (
        collector_id,status,last_attempt_at,last_error,failure_code,failure_stage,
        failure_summary,updated_at
      ) VALUES ('other-cron','error',?,'stream prediction failed','prediction','prediction',?,?)
      ON CONFLICT(collector_id) DO UPDATE SET
        status='error',last_attempt_at=excluded.last_attempt_at,last_error=excluded.last_error,
        failure_code=excluded.failure_code,failure_stage=excluded.failure_stage,
        failure_summary=excluded.failure_summary,updated_at=excluded.updated_at`)
      .bind(at, message, at).run();
    return true;
  } catch (stateError) {
    if (/no such table/i.test(String(stateError?.message || stateError))) return false;
    throw stateError;
  }
}

export async function runOtherMonitorScheduled(controller, env, _ctx, dependencies = EMPTY_DEPENDENCIES) {
  const cron = String(controller?.cron || '');
  if (cron !== OTHER_MONITOR_CRON) return [{ skipped: true, reason: 'unsupported-other-monitor-cron', cron }];
  const now = scheduledTimestamp(controller);
  if (otherMonitorTask(now) !== 'prediction') return [{ skipped: true, reason: 'prediction-not-due' }];
  const run = dependencies.prediction || (await loadPredictionModule()).runStreamGoalPrediction;
  return [await run(env, now)];
}

export async function runOtherMonitorCron(controller, env, ctx, options = {}) {
  const now = scheduledTimestamp(controller);
  try {
    const result = await runOtherMonitorScheduled(
      controller,
      env,
      ctx,
      options.dependencies || EMPTY_DEPENDENCIES,
    );
    await (options.recordSuccess || recordSuccess)(env, now);
    return result;
  } catch (error) {
    await (options.recordFailure || recordFailure)(env, error, now).catch(() => {});
    throw error;
  }
}

export async function runOtherMonitorQueue(batch) {
  for (const message of batch?.messages || []) {
    if (message?.body?.message_type === OTHER_SUCCESS_MESSAGE) message.ack();
    else message.retry();
  }
}

export default {
  scheduled: runOtherMonitorCron,
  queue: runOtherMonitorQueue,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return Response.json({ ok: true, worker: 'sh-runtime-orchestrator', scope: 'stream-prediction' }, {
        headers: { 'cache-control': 'no-store' },
      });
    }
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
