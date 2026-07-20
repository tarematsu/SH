const RETRY_60_SECONDS = Object.freeze({ delaySeconds: 60 });
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
export const BUDGET_LIVE_WRITE_STAGE = 'budget-live-write';

function activeQueueEnvironment(env) {
  if (env?.MINUTE_DERIVE_QUEUE || !env?.MINUTE_LIVE_DERIVE_QUEUE) return env;
  const active = Object.create(env);
  Object.defineProperty(active, 'MINUTE_DERIVE_QUEUE', {
    value: env.MINUTE_LIVE_DERIVE_QUEUE,
    enumerable: false,
    configurable: true,
  });
  return active;
}

function validStageBody(body, stage) {
  return body?.message_type === 'minute-fact-derive-stage'
    && Number(body?.message_version) === 1
    && body?.stage === stage
    && body?.payload?.rebuild !== true;
}

async function sendStage(env, body, dependencies = {}) {
  if (dependencies.sendStage) return dependencies.sendStage(body);
  const queue = env?.MINUTE_DERIVE_QUEUE || env?.MINUTE_LIVE_DERIVE_QUEUE;
  if (!queue?.send) throw new Error('minute live derive Queue binding is missing');
  return queue.send(body, JSON_QUEUE_SEND_OPTIONS);
}

async function prepareLiveWrite(env, body, dependencies = {}) {
  const materializer = dependencies.materializer || await import('./minute-revision-materializer.js');
  if (!materializer.shouldMaterializeLiveRevision(env, body.payload)) {
    return commitLiveWrite(env, { ...body, stage: BUDGET_LIVE_WRITE_STAGE }, dependencies);
  }
  const revision = await materializer.prepareSparseLiveRevision(
    env,
    body.payload,
    { sourceJobId: body?.job?.id },
    dependencies.materializerDependencies || {},
  );
  await sendStage(env, {
    ...body,
    stage: BUDGET_LIVE_WRITE_STAGE,
    prepared_revision: revision,
  }, dependencies);
  return { prepared: true, revision_id: Number(revision?.revision_id || 0) || null };
}

async function commitLiveWrite(env, body, dependencies = {}) {
  const activeEnv = activeQueueEnvironment(env);
  const [{ withAppleMusicFreeRuntime }, { withMinuteD1WriteThrottle }, deriveQueue, fastStore] = await Promise.all([
    dependencies.appleRuntime || import('../../site/functions/lib/apple-music-d1-pruner.js'),
    dependencies.writeThrottle || import('./minute-d1-write-throttle.js'),
    dependencies.deriveQueue || import('./minute-derive-queue.js'),
    dependencies.fastStore || import('./minute-facts-fast-store.js'),
  ]);
  const budgetEnv = withMinuteD1WriteThrottle(withAppleMusicFreeRuntime(activeEnv));
  const preparedRevision = body.prepared_revision || null;
  const result = await deriveQueue.processMinuteDeriveWriteStage(
    budgetEnv,
    { ...body, stage: 'write' },
    {
      stageRevision: false,
      async write(active, payload) {
        return fastStore.saveOptimizedMinuteFactWithinBudget(active, {
          ...payload,
          ...(preparedRevision ? { prepared_revision: preparedRevision } : {}),
        });
      },
    },
  );
  if (preparedRevision?.staged) {
    await sendStage(budgetEnv, {
      message_type: 'minute-fact-derive-stage',
      message_version: 1,
      stage: 'revision-materialize',
      job: body.job,
      revision: preparedRevision,
      started_at: body.started_at,
    }, dependencies);
  }
  return result;
}

export async function processBudgetedLiveWriteMessage(env, body, dependencies = {}) {
  if (validStageBody(body, 'write')) return prepareLiveWrite(activeQueueEnvironment(env), body, dependencies);
  if (validStageBody(body, BUDGET_LIVE_WRITE_STAGE)) {
    return commitLiveWrite(activeQueueEnvironment(env), body, dependencies);
  }
  throw new Error('unsupported budgeted live write message');
}

export async function processBudgetedLiveWriteBatch(batch, env, dependencies = {}) {
  for (const message of batch?.messages || []) {
    try {
      await processBudgetedLiveWriteMessage(env, message.body, dependencies);
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({
        event: 'minute_live_write_budget_failed',
        stage: String(message?.body?.stage || ''),
        error: String(error?.message || error).slice(0, 800),
      }));
      message.retry(RETRY_60_SECONDS);
    }
  }
}
