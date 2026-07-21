const RETRY_60_SECONDS = Object.freeze({ delaySeconds: 60 });
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
export const BUDGET_LIVE_WRITE_STAGE = 'budget-live-write';

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function activeQueueEnvironment(env) {
  const liveQueue = env?.MINUTE_LIVE_DERIVE_QUEUE;
  if (!liveQueue || env?.MINUTE_DERIVE_QUEUE === liveQueue) return env;
  const active = Object.create(env || null);
  Object.defineProperty(active, 'MINUTE_DERIVE_QUEUE', {
    value: liveQueue,
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

function validatePayload(payload, payloadVersion = null) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('invalid durable minute fact payload');
  }
  if (Number(payload.payload_version || payloadVersion || 0) !== 1) {
    throw new Error(`unsupported minute fact payload version: ${payload.payload_version || payloadVersion}`);
  }
  return payload;
}

export async function loadDurableLivePayload(env, body, dependencies = {}) {
  if (body?.payload != null) return validatePayload(body.payload, body?.job?.payload_version);
  if (dependencies.loadPayload) {
    return validatePayload(await dependencies.loadPayload(env, body), body?.job?.payload_version);
  }
  const jobId = integer(body?.job?.id);
  const db = env?.MINUTE_DB;
  if (jobId == null || !db?.prepare) throw new Error('durable minute fact job identity is missing');
  const row = await db.prepare(`SELECT payload_json,payload_version
    FROM sh_minute_fact_jobs WHERE id=? LIMIT 1`).bind(jobId).first();
  if (!row) throw new Error(`minute fact job ${jobId} source payload is missing`);
  let payload;
  try {
    payload = JSON.parse(String(row.payload_json || ''));
  } catch (error) {
    throw new Error(`invalid minute fact job payload: ${error?.message || error}`);
  }
  return validatePayload(payload, row.payload_version ?? body?.job?.payload_version);
}

function compactStageBody(body) {
  const { payload: _payload, ...compact } = body || {};
  return { ...compact, durable_payload: true };
}

async function sendStage(env, body, dependencies = {}) {
  if (dependencies.sendStage) return dependencies.sendStage(body);
  const queue = env?.MINUTE_LIVE_DERIVE_QUEUE || env?.MINUTE_DERIVE_QUEUE;
  if (!queue?.send) throw new Error('minute live derive Queue binding is missing');
  return queue.send(body, JSON_QUEUE_SEND_OPTIONS);
}

async function prepareLiveWrite(env, body, dependencies = {}) {
  const payload = await loadDurableLivePayload(env, body, dependencies);
  const materializer = dependencies.materializer || await import('./minute-revision-materializer.js');
  if (!materializer.shouldMaterializeLiveRevision(env, payload)) {
    await sendStage(env, {
      ...compactStageBody(body),
      stage: BUDGET_LIVE_WRITE_STAGE,
    }, dependencies);
    return { prepared: true, revision_id: null };
  }
  const revision = await materializer.prepareSparseLiveRevision(
    env,
    payload,
    { sourceJobId: body?.job?.id },
    dependencies.materializerDependencies || {},
  );
  await sendStage(env, {
    ...compactStageBody(body),
    stage: BUDGET_LIVE_WRITE_STAGE,
    prepared_revision: revision,
  }, dependencies);
  return { prepared: true, revision_id: Number(revision?.revision_id || 0) || null };
}

async function commitLiveWrite(env, body, dependencies = {}) {
  const activeEnv = activeQueueEnvironment(env);
  const payload = await loadDurableLivePayload(activeEnv, body, dependencies);
  const [
    { withAppleMusicFreeRuntime },
    { withMinuteD1WriteThrottling },
    deriveQueue,
    fastStore,
  ] = await Promise.all([
    dependencies.appleRuntime || import('../../site/functions/lib/apple-music-d1-pruner.js'),
    dependencies.writeThrottle || import('./minute-d1-write-throttle.js'),
    dependencies.deriveQueue || import('./minute-derive-queue.js'),
    dependencies.fastStore || import('./minute-facts-fast-store.js'),
  ]);
  const budgetEnv = withMinuteD1WriteThrottling(withAppleMusicFreeRuntime(activeEnv));
  const preparedRevision = body.prepared_revision || null;
  const result = await deriveQueue.processMinuteDeriveWriteStage(
    budgetEnv,
    { ...body, stage: 'write', payload },
    {
      stageRevision: false,
      async write(active, value) {
        return fastStore.saveOptimizedMinuteFactWithinBudget(active, {
          ...value,
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
  const activeEnv = activeQueueEnvironment(env);
  if (validStageBody(body, 'write')) return prepareLiveWrite(activeEnv, body, dependencies);
  if (validStageBody(body, BUDGET_LIVE_WRITE_STAGE)) {
    return commitLiveWrite(activeEnv, body, dependencies);
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
