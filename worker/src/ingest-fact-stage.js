import { handoffMinuteFactJob } from './minute-facts-queue.js';

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function validateFactTask(body) {
  const fact = objectValue(body?.fact);
  if (body?.message_type !== 'stationhead-ingest-fact'
      || integer(body?.message_version) !== 1
      || !fact
      || !objectValue(fact.snapshot)
      || !objectValue(fact.options)
      || !objectValue(fact.collectorState)) {
    throw new Error('unsupported ingest fact task');
  }
  if (integer(fact.observedAt) == null || integer(fact.snapshot.channel_id) == null) {
    throw new Error('ingest fact identity is invalid');
  }
  return fact;
}

function commentsTask(fact, body) {
  body.read_model = null;
  return {
    message_type: 'stationhead-comments-task',
    message_version: 2,
    auth: fact.auth || {},
    observed_at: integer(fact.observedAt) ?? Date.now(),
    station_id: integer(fact.snapshot?.station_id),
    minute_fact: body,
  };
}

function readModelEnvelope(fact, body) {
  const compact = objectValue(body?.read_model) || objectValue(fact.options?.readModel);
  if (!compact) throw new Error('minute fact read model is missing');
  const observedAt = integer(fact.observedAt) ?? integer(body?.payload?.observedAt) ?? Date.now();
  const channelId = integer(fact.snapshot?.channel_id) ?? integer(body?.channel_id);
  const compactChannel = objectValue(compact.channel) || {};
  const compactQueue = objectValue(compact.queue);
  const compactCollector = objectValue(compact.collector) || {};
  compactChannel.observed_at = observedAt;
  if (compactQueue && !Object.hasOwn(compactQueue, 'value')) {
    compactQueue.value = body?.payload?.queue ?? fact.queue ?? null;
  }
  compactCollector.last_run_at = observedAt;
  compactCollector.last_success_at = observedAt;
  compactCollector.updated_at = observedAt;
  compact.channel = compactChannel;
  compact.queue = compactQueue;
  compact.collector = compactCollector;
  return {
    message_type: 'stationhead-read-model',
    message_version: 1,
    observed_at: observedAt,
    job_id: `read-model:${channelId}:${observedAt}`,
    read_model: compact,
    comment_task: {
      observed_at: observedAt,
      station_id: integer(fact.snapshot?.station_id),
      auth: fact.auth || {},
    },
  };
}

function activeFactEnv(env, fact, capture) {
  const active = Object.create(env || null);
  const commentsQueue = env?.COMMENTS_QUEUE;
  Object.defineProperty(active, 'MINUTE_FACT_QUEUE', {
    enumerable: false,
    value: commentsQueue?.send ? {
      send(body, options) {
        if (body && typeof body === 'object') capture.envelope = readModelEnvelope(fact, body);
        return commentsQueue.send(commentsTask(fact, body), options);
      },
    } : commentsQueue,
  });
  return active;
}

async function recoverReadModelEnvelope(env, fact, minuteAt) {
  const channelId = integer(fact.snapshot?.channel_id);
  const jobId = `minute-fact:${channelId}:${integer(minuteAt)}`;
  try {
    const row = await env.DB.prepare(`SELECT payload_json
      FROM sh_minute_fact_outbox
      WHERE job_id=? AND status='pending'
      LIMIT 1`).bind(jobId).first();
    if (row?.payload_json) return readModelEnvelope(fact, JSON.parse(String(row.payload_json)));
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'current_read_model_outbox_reuse_failed',
      job_id: jobId,
      error: String(error?.message || error).slice(0, 500),
    }));
  }
  return readModelEnvelope(fact, {
    channel_id: channelId,
    payload: {
      observedAt: fact.observedAt,
      snapshot: fact.snapshot,
      queue: fact.queue ?? null,
    },
    read_model: fact.options.readModel,
  });
}

async function enqueueFinalize(env, fact, envelope, dependencies = {}) {
  const send = dependencies.sendFinalize
    || ((message) => env.INGEST_FINALIZE_QUEUE.send(message, { contentType: 'json' }));
  if (!dependencies.sendFinalize && !env?.INGEST_FINALIZE_QUEUE?.send) {
    throw new Error('INGEST_FINALIZE_QUEUE binding is missing');
  }
  await send({
    message_type: 'stationhead-ingest-finalize',
    message_version: 1,
    observed_at: integer(fact.observedAt),
    channel_id: integer(fact.snapshot?.channel_id),
    collector_state: fact.collectorState,
    read_model: envelope,
  });
}

export async function processIngestFactTask(env, body, dependencies = {}) {
  const fact = validateFactTask(body);
  const capture = { envelope: null };
  const active = activeFactEnv(env, fact, capture);
  const handoff = dependencies.handoffMinuteFactJob || handoffMinuteFactJob;
  const minuteFactJob = await handoff(active, {
    observedAt: fact.observedAt,
    snapshot: fact.snapshot,
    queue: fact.queue ?? null,
    comments: fact.comments || {},
  }, fact.options);
  const minuteAt = integer(minuteFactJob?.minute_at);
  const envelope = capture.envelope || await recoverReadModelEnvelope(env, fact, minuteAt);
  await enqueueFinalize(env, fact, envelope, dependencies);
  return {
    event: 'ingest_fact_completed',
    observed_at: integer(fact.observedAt),
    channel_id: integer(fact.snapshot.channel_id),
    minute_at: minuteAt,
    minute_fact_job_enqueued: Boolean(minuteFactJob?.enqueued),
    minute_fact_outbox_pending: Boolean(minuteFactJob?.outbox_pending),
  };
}
