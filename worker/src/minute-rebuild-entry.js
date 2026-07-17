function validateTask(body) {
  if (body?.message_type !== 'minute-rebuild-stage'
      || Number(body?.message_version) !== 1) {
    throw new Error('unsupported minute rebuild task');
  }
  const stage = String(body.stage || '');
  if (!['gap-scan', 'backfill'].includes(stage)) throw new Error(`unsupported minute rebuild stage: ${stage}`);
  return {
    stage,
    runId: String(body.run_id || ''),
    scheduledAt: Number(body.scheduled_at) || Date.now(),
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

export async function processMinuteRebuildStage(env, body, dependencies = {}) {
  const task = validateTask(body);
  if (!env?.BUDDIES_DB || !env?.MINUTE_DB) throw new Error('minute rebuild database binding is missing');
  const startedAt = Date.now();
  const active = sourceEnv(env);

  try {
    if (task.stage === 'gap-scan') {
      const run = dependencies.runGapScan
        || (await import('./minute-facts-gap-scan.js')).runMinuteFactsGapScan;
      const result = await run(active, dependencies.gapScan || {});
      await recordStage(env, task, result, startedAt);
      if (!env?.MINUTE_REBUILD_QUEUE?.send) throw new Error('MINUTE_REBUILD_QUEUE binding is missing');
      await env.MINUTE_REBUILD_QUEUE.send({
        message_type: 'minute-rebuild-stage',
        message_version: 1,
        run_id: task.runId,
        stage: 'backfill',
        scheduled_at: task.scheduledAt,
      }, { contentType: 'json' });
      return { stage: task.stage, run_id: task.runId, pending: true, result };
    }

    const run = dependencies.runBackfill
      || (await import('./minute-facts-backfill.js')).runMinuteFactsBackfill;
    const result = await run(active, dependencies.backfill || {});
    await recordStage(env, task, result, startedAt);
    return { stage: task.stage, run_id: task.runId, pending: false, result };
  } catch (error) {
    await recordStage(env, task, { error: String(error?.message || error).slice(0, 800) }, startedAt, false)
      .catch(() => {});
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
