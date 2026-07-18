import { minuteDeriveTrigger } from './minute-derive-trigger.js';

const EMPTY_DEPENDENCIES = Object.freeze({});
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
let runtimeStateModulePromise;
let gapScanModulePromise;
let backfillModulePromise;

function validStage(stage) {
  switch (stage) {
    case 'gap-scan':
    case 'gap-commit':
    case 'backfill':
    case 'backfill-prepare':
    case 'backfill-commit':
      return true;
    default:
      return false;
  }
}

function validateTask(body) {
  if (body?.message_type !== 'minute-rebuild-stage'
      || Number(body?.message_version) !== 1) {
    throw new Error('unsupported minute rebuild task');
  }
  const stage = String(body.stage || '');
  if (!validStage(stage)) {
    throw new Error(`unsupported minute rebuild stage: ${stage}`);
  }
  return {
    stage,
    runId: String(body.run_id || ''),
    scheduledAt: Number(body.scheduled_at) || Date.now(),
    prepared: body.prepared || null,
  };
}

function sourceEnv(env) {
  const active = Object.create(env || null);
  Object.defineProperty(active, 'DB', { value: env?.BUDDIES_DB, enumerable: false });
  return active;
}

function loadRuntimeStateModule() {
  runtimeStateModulePromise ||= import('./minute-facts-runtime-state.js');
  return runtimeStateModulePromise;
}

function loadGapScanModule() {
  gapScanModulePromise ||= import('./minute-facts-gap-scan.js');
  return gapScanModulePromise;
}

function loadBackfillModule() {
  backfillModulePromise ||= import('./minute-facts-backfill-stages.js');
  return backfillModulePromise;
}

async function recordStage(env, task, result, startedAt, success = true) {
  if (!env?.MINUTE_DB) return;
  const { recordMinuteFactRuntimeState } = await loadRuntimeStateModule();
  await recordMinuteFactRuntimeState(env, 'rebuild', {
    processed: Number(result?.processed ?? result?.enqueued ?? 0),
    failed: success ? 0 : 1,
    stage: task.stage,
    run_id: task.runId,
    ...result,
  }, { startedAt, success });
}

async function enqueueStage(env, task, stage, delaySeconds = 0, details = null) {
  if (!env?.MINUTE_REBUILD_QUEUE?.send) throw new Error('MINUTE_REBUILD_QUEUE binding is missing');
  const message = {
    message_type: 'minute-rebuild-stage',
    message_version: 1,
    run_id: task.runId,
    stage,
    scheduled_at: task.scheduledAt,
    ...(details || {}),
  };
  const options = delaySeconds > 0
    ? { contentType: 'json', delaySeconds }
    : JSON_QUEUE_SEND_OPTIONS;
  await env.MINUTE_REBUILD_QUEUE.send(message, options);
}

function preparedDeriveCandidate(task, result) {
  if (result?.stale_candidate === true || task.prepared?.skip_existing === true) return null;
  if (task.stage === 'gap-commit') return task.prepared?.attempted?.[0] || null;
  if (task.stage === 'backfill-commit') return task.prepared?.candidate || null;
  return null;
}

async function dispatchPreparedDerive(env, task, result, dependencies = EMPTY_DEPENDENCIES) {
  const candidate = preparedDeriveCandidate(task, result);
  const channelId = Number(candidate?.snapshot?.channel_id);
  const observedAt = Number(candidate?.observedAt);
  const explicitMinuteAt = Number(candidate?.minuteAt);
  const minuteAt = Number.isFinite(explicitMinuteAt)
    ? Math.trunc(explicitMinuteAt)
    : Number.isFinite(observedAt)
      ? Math.floor(observedAt / 60_000) * 60_000
      : null;
  if (!Number.isFinite(channelId) || minuteAt == null) return false;
  const sendDerive = dependencies.sendDerive;
  if (!sendDerive && !env?.MINUTE_DERIVE_QUEUE?.send) return false;

  const message = minuteDeriveTrigger({ channel_id: channelId, minute_at: minuteAt });
  try {
    if (sendDerive) await sendDerive(message);
    else await env.MINUTE_DERIVE_QUEUE.send(message, JSON_QUEUE_SEND_OPTIONS);
    return true;
  } catch (error) {
    // The durable inbox row remains pending and the every-minute maintenance
    // dispatcher will recover it. Do not stall rebuild source scanning merely
    // because the low-latency Queue handoff failed once.
    console.warn(JSON.stringify({
      event: 'minute_rebuild_derive_dispatch_failed',
      channel_id: Math.trunc(channelId),
      minute_at: minuteAt,
      error: String(error?.message || error).slice(0, 800),
    }));
    return false;
  }
}

export async function processMinuteRebuildStage(env, body, dependencies = EMPTY_DEPENDENCIES) {
  const task = validateTask(body);
  if (!env?.BUDDIES_DB || !env?.MINUTE_DB) throw new Error('minute rebuild database binding is missing');
  const startedAt = Date.now();
  const active = sourceEnv(env);
  const record = dependencies.recordStage || recordStage;
  const enqueue = dependencies.enqueueStage || enqueueStage;

  try {
    if (task.stage === 'gap-scan') {
      // Compatibility path for tests and rollback callers that still inject the
      // former single-invocation scanner.
      if (dependencies.runGapScan) {
        const result = await dependencies.runGapScan(active, dependencies.gapScan || EMPTY_DEPENDENCIES);
        await record(env, task, result, startedAt);
        await enqueue(env, task, 'backfill');
        return { stage: task.stage, run_id: task.runId, pending: true, result };
      }

      const stages = await loadGapScanModule();
      const prepare = dependencies.prepareGapScan || stages.prepareMinuteFactsGapScan;
      const prepared = await prepare(active, dependencies.gapScan || EMPTY_DEPENDENCIES);
      if (prepared?.skipped) {
        await record(env, task, prepared, startedAt);
        await enqueue(env, task, 'backfill');
        return { stage: task.stage, run_id: task.runId, pending: true, result: prepared };
      }
      await enqueue(env, task, 'gap-commit', 0, { prepared });
      return {
        stage: task.stage,
        run_id: task.runId,
        pending: true,
        result: {
          event: 'minute_fact_gap_scan_prepared',
          from: prepared.from,
          to: prepared.to,
          expected_minutes: prepared.expected_minutes,
          missing_minutes: prepared.missing_minutes,
          attempted_jobs: prepared.attempted?.length || 0,
        },
      };
    }

    if (task.stage === 'gap-commit') {
      const stages = await loadGapScanModule();
      const commit = dependencies.commitGapScan || stages.commitMinuteFactsGapScan;
      const result = await commit(active, task.prepared, dependencies.gapScan || EMPTY_DEPENDENCIES);
      const reported = {
        ...result,
        derive_dispatched: await dispatchPreparedDerive(env, task, result, dependencies),
      };
      await record(env, { ...task, stage: 'gap-scan' }, reported, startedAt);
      await enqueue(env, task, 'backfill');
      return { stage: task.stage, run_id: task.runId, pending: true, result: reported };
    }

    // Test and rollout fallback for the former single-invocation backfill.
    if (task.stage === 'backfill' && dependencies.runBackfill) {
      const result = await dependencies.runBackfill(active, dependencies.backfill || EMPTY_DEPENDENCIES);
      await record(env, task, result, startedAt);
      const pending = Number(result?.pending_candidates || 0) > 0
        || Number(result?.scanned_snapshots || 0) > 0;
      if (pending) await enqueue(env, task, 'backfill', 1);
      return { stage: task.stage, run_id: task.runId, pending, result };
    }

    const stages = await loadBackfillModule();
    if (task.stage === 'backfill') {
      const scan = dependencies.scanBackfill || stages.scanMinuteFactsBackfill;
      const result = await scan(active, dependencies.backfill || EMPTY_DEPENDENCIES);
      const pending = Number(result?.pending_candidates || 0) > 0;
      if (pending) {
        await enqueue(env, task, 'backfill-prepare');
      } else {
        await record(env, { ...task, stage: 'backfill' }, result, startedAt);
      }
      return { stage: task.stage, run_id: task.runId, pending, result };
    }

    if (task.stage === 'backfill-prepare') {
      const prepare = dependencies.prepareBackfill || stages.prepareMinuteFactsBackfillCandidate;
      const result = await prepare(active, dependencies.backfill || EMPTY_DEPENDENCIES);
      const pending = Boolean(result?.prepared);
      if (pending) {
        await enqueue(env, task, 'backfill-commit', 0, { prepared: result.prepared });
      }
      return { stage: task.stage, run_id: task.runId, pending, result: {
        pending_candidates: Number(result?.pending_candidates || 0),
        prepared: pending,
      } };
    }

    const commit = dependencies.commitBackfill || stages.commitMinuteFactsBackfillCandidate;
    const result = await commit(active, task.prepared, dependencies.backfill || EMPTY_DEPENDENCIES);
    const reported = {
      ...result,
      derive_dispatched: await dispatchPreparedDerive(env, task, result, dependencies),
    };
    await record(env, { ...task, stage: 'backfill' }, reported, startedAt);
    const remaining = Number(result?.pending_candidates || 0);
    if (remaining > 0) await enqueue(env, task, 'backfill-prepare', 1);
    else await enqueue(env, task, 'backfill', 1);
    return { stage: task.stage, run_id: task.runId, pending: true, result: reported };
  } catch (error) {
    await record(env, { ...task, stage: task.stage.startsWith('backfill') ? 'backfill' : task.stage === 'gap-commit' ? 'gap-scan' : task.stage }, {
      error: String(error?.message || error).slice(0, 800),
    }, startedAt, false).catch(() => {});
    throw error;
  }
}

async function processMinuteRebuildBatch(batch, env) {
  const messages = batch.messages;
  if (!messages?.length) return;
  const message = messages[0];
  try {
    const result = await processMinuteRebuildStage(env, message.body);
    console.log(JSON.stringify({ event: 'minute_rebuild_stage_completed', ...result }));
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      event: 'minute_rebuild_stage_failed',
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry({ delaySeconds: 60 });
  }
}

export default {
  queue: processMinuteRebuildBatch,
};
