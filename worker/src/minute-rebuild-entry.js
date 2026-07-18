function validateTask(body) {
  if (body?.message_type !== 'minute-rebuild-stage'
      || Number(body?.message_version) !== 1) {
    throw new Error('unsupported minute rebuild task');
  }
  const stage = String(body.stage || '');
  if (!['gap-scan', 'backfill', 'backfill-prepare', 'backfill-commit'].includes(stage)) {
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

async function recordStage(env, task, result, startedAt, success = true) {
  if (!env?.MINUTE_DB) return;
  const { recordMinuteFactRuntimeState } = await import('./minute-facts-runtime-state.js');
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
  await env.MINUTE_REBUILD_QUEUE.send({
    message_type: 'minute-rebuild-stage',
    message_version: 1,
    run_id: task.runId,
    stage,
    scheduled_at: task.scheduledAt,
    ...(details || {}),
  }, {
    contentType: 'json',
    ...(delaySeconds > 0 ? { delaySeconds } : {}),
  });
}

export async function processMinuteRebuildStage(env, body, dependencies = {}) {
  const task = validateTask(body);
  if (!env?.BUDDIES_DB || !env?.MINUTE_DB) throw new Error('minute rebuild database binding is missing');
  const startedAt = Date.now();
  const active = sourceEnv(env);
  const record = dependencies.recordStage || recordStage;
  const enqueue = dependencies.enqueueStage || enqueueStage;

  try {
    if (task.stage === 'gap-scan') {
      const run = dependencies.runGapScan
        || (await import('./minute-facts-gap-scan.js')).runMinuteFactsGapScan;
      const result = await run(active, dependencies.gapScan || {});
      await record(env, task, result, startedAt);
      await enqueue(env, task, 'backfill');
      return { stage: task.stage, run_id: task.runId, pending: true, result };
    }

    // Test and rollout fallback for the former single-invocation backfill.
    if (task.stage === 'backfill' && dependencies.runBackfill) {
      const result = await dependencies.runBackfill(active, dependencies.backfill || {});
      await record(env, task, result, startedAt);
      const pending = Number(result?.pending_candidates || 0) > 0
        || Number(result?.scanned_snapshots || 0) > 0;
      if (pending) await enqueue(env, task, 'backfill', 1);
      return { stage: task.stage, run_id: task.runId, pending, result };
    }

    const stages = await import('./minute-facts-backfill-stages.js');
    if (task.stage === 'backfill') {
      const scan = dependencies.scanBackfill || stages.scanMinuteFactsBackfill;
      const result = await scan(active, dependencies.backfill || {});
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
      const result = await prepare(active, dependencies.backfill || {});
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
    const result = await commit(active, task.prepared, dependencies.backfill || {});
    await record(env, { ...task, stage: 'backfill' }, result, startedAt);
    const remaining = Number(result?.pending_candidates || 0);
    if (remaining > 0) await enqueue(env, task, 'backfill-prepare', 1);
    else await enqueue(env, task, 'backfill', 1);
    return { stage: task.stage, run_id: task.runId, pending: true, result };
  } catch (error) {
    await record(env, { ...task, stage: task.stage.startsWith('backfill') ? 'backfill' : task.stage }, {
      error: String(error?.message || error).slice(0, 800),
    }, startedAt, false).catch(() => {});
    throw error;
  }
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages || []) {
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
  },
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
