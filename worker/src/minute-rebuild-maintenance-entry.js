import { withBackfillCursorSeek } from './backfill-cursor-seek.js';
import rebuildWorker from './minute-rebuild-entry.js';
import { runMinuteScheduled } from './minute-entry.js';

const EMPTY_DEPENDENCIES = Object.freeze({});
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
const RETRY_60_SECONDS = Object.freeze({ delaySeconds: 60 });
const GATE_RETRY_SECONDS = 4;
const GATE_MAX_ATTEMPTS = 3;
const REBUILD_SLOT_MS = 10 * 60_000;
const DEFAULT_HISTORICAL_BACKFILL_INTERVAL_MS = 24 * 60 * 60_000;
const MAX_HISTORICAL_BACKFILL_INTERVAL_MS = 7 * 24 * 60 * 60_000;

function finiteTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : Date.now();
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Date.now();
}

function enabled(value, fallback = true) {
  if (value == null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function historicalBackfillIntervalMs(env = {}) {
  const parsed = Math.trunc(Number(env.REBUILD_HISTORICAL_BACKFILL_INTERVAL_MS));
  if (!Number.isFinite(parsed) || parsed < REBUILD_SLOT_MS) {
    return DEFAULT_HISTORICAL_BACKFILL_INTERVAL_MS;
  }
  return Math.min(parsed, MAX_HISTORICAL_BACKFILL_INTERVAL_MS);
}

export function historicalBackfillDue(env, scheduledAt) {
  if (!enabled(env?.REBUILD_HISTORICAL_BACKFILL_ENABLED, true)) return false;
  const timestamp = finiteTimestamp(scheduledAt);
  const interval = historicalBackfillIntervalMs(env);
  return Math.floor(timestamp / interval) !== Math.floor((timestamp - REBUILD_SLOT_MS) / interval);
}

function maintenanceStage(body) {
  if (body?.message_type !== 'minute-rebuild-stage' || Number(body?.message_version) !== 1) return null;
  if (body.stage === 'maintenance-gate' || body.stage === 'maintenance-sync') return body.stage;
  return null;
}

function validateMaintenanceTask(body) {
  const task = body?.maintenance_task;
  if (task !== 'rebuild' && task !== 'sync') {
    throw new Error(`unsupported minute maintenance task: ${String(task || '')}`);
  }
  return {
    task,
    runId: String(body.run_id || ''),
    scheduledAt: finiteTimestamp(body.scheduled_at),
    cron: typeof body.cron === 'string' ? body.cron : String(body.cron || ''),
    attempt: Math.max(0, Math.trunc(Number(body.attempt) || 0)),
  };
}

async function collectorReady(env, scheduledAt) {
  const db = env?.BUDDIES_DB;
  if (!db?.prepare) return { ready: true, reason: 'buddies-db-binding-missing' };
  const targetMinute = Math.floor(scheduledAt / 60_000) * 60_000;
  try {
    const row = await db.prepare(`SELECT last_run_at,last_success_at,last_error
      FROM sh_worker_collector_state WHERE id='stationhead' LIMIT 1`).first();
    return {
      ready: Number(row?.last_run_at || 0) >= targetMinute
        && Number(row?.last_success_at || 0) >= targetMinute
        && !row?.last_error,
      targetMinute,
    };
  } catch (error) {
    if (/no such table|no such column/i.test(String(error?.message || error))) {
      return { ready: true, reason: 'collector-state-unavailable', targetMinute };
    }
    throw error;
  }
}

async function sendStage(env, body, delaySeconds = 0, dependencies = EMPTY_DEPENDENCIES) {
  if (dependencies.send) return dependencies.send(body, delaySeconds);
  if (!env?.MINUTE_REBUILD_QUEUE?.send) throw new Error('MINUTE_REBUILD_QUEUE binding is missing');
  const options = delaySeconds > 0
    ? { contentType: 'json', delaySeconds }
    : JSON_QUEUE_SEND_OPTIONS;
  return env.MINUTE_REBUILD_QUEUE.send(body, options);
}

export async function processMinuteMaintenanceGate(env, body, dependencies = EMPTY_DEPENDENCIES) {
  const task = validateMaintenanceTask(body);
  const check = dependencies.checkCollector || collectorReady;
  const collector = await check(env, task.scheduledAt);
  if (!collector?.ready) {
    if (task.attempt < GATE_MAX_ATTEMPTS) {
      await sendStage(env, {
        ...body,
        attempt: task.attempt + 1,
      }, GATE_RETRY_SECONDS, dependencies);
      return {
        stage: 'maintenance-gate',
        task: task.task,
        run_id: task.runId,
        pending: true,
        requeued: true,
        attempt: task.attempt + 1,
      };
    }
    return {
      stage: 'maintenance-gate',
      task: task.task,
      run_id: task.runId,
      skipped: true,
      reason: collector?.reason || 'collector-not-ready',
    };
  }

  if (task.task === 'rebuild') {
    const allowBackfill = historicalBackfillDue(env, task.scheduledAt);
    await sendStage(env, {
      message_type: 'minute-rebuild-stage',
      message_version: 1,
      run_id: `minute-rebuild:${task.scheduledAt}`,
      stage: 'gap-scan',
      scheduled_at: task.scheduledAt,
      allow_backfill: allowBackfill,
    }, 0, dependencies);
    return {
      stage: 'maintenance-gate',
      task: task.task,
      run_id: task.runId,
      pending: true,
      dispatched_stage: 'gap-scan',
      historical_backfill_due: allowBackfill,
    };
  }

  await sendStage(env, {
    ...body,
    stage: 'maintenance-sync',
  }, 0, dependencies);
  return {
    stage: 'maintenance-gate',
    task: task.task,
    run_id: task.runId,
    pending: true,
    dispatched_stage: 'maintenance-sync',
  };
}

export async function processMinuteMaintenanceSync(env, body, dependencies = EMPTY_DEPENDENCIES) {
  const task = validateMaintenanceTask(body);
  if (task.task !== 'sync') throw new Error('maintenance sync stage requires a sync task');
  const run = dependencies.runScheduled || runMinuteScheduled;
  const result = await run({ cron: task.cron, scheduledTime: task.scheduledAt }, env, {
    collectorReady: true,
  });
  return {
    stage: 'maintenance-sync',
    task: task.task,
    run_id: task.runId,
    pending: false,
    result,
  };
}

function logMaintenanceGateResult(result) {
  console.log(JSON.stringify({
    event: 'minute_maintenance_gate_completed',
    stage: result?.stage,
    task: result?.task,
    run_id: result?.run_id,
    pending: result?.pending === true,
    skipped: result?.skipped === true,
    reason: result?.reason,
    requeued: result?.requeued === true,
    attempt: result?.attempt,
    dispatched_stage: result?.dispatched_stage,
    historical_backfill_due: result?.historical_backfill_due,
  }));
}

async function processMinuteRebuildBatch(batch, env, ctx) {
  const messages = batch?.messages;
  if (!messages?.length) return;
  const message = messages[0];
  const stage = maintenanceStage(message.body);
  if (!stage) return rebuildWorker.queue(batch, withBackfillCursorSeek(env), ctx);
  try {
    const result = stage === 'maintenance-sync'
      ? await processMinuteMaintenanceSync(env, message.body)
      : await processMinuteMaintenanceGate(env, message.body);
    logMaintenanceGateResult(result);
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'minute_maintenance_gate_failed',
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry(RETRY_60_SECONDS);
  }
}

export default {
  queue: processMinuteRebuildBatch,
};
