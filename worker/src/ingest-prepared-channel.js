import {
  minuteFactQueue,
  readModelPresentation,
} from './collector-payload.js';
import {
  collectPreparedOnce,
  preparedCollectorFactStage,
  preparedCollectorFinalizeState,
} from './prepared-collector-runner.js';
import {
  handoffMinuteFactJob,
  parseMinuteFactQueueMessage,
} from './minute-facts-queue.js';

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function preparedCollection(message) {
  if (message?.message_type !== 'stationhead-raw-channel'
      || integer(message?.message_version) !== 3) {
    throw new Error('unsupported prepared raw collection message');
  }
  const snapshot = objectValue(message.snapshot);
  const queue = message.queue == null ? null : objectValue(message.queue);
  const channelId = integer(snapshot?.channel_id);
  const stationId = integer(snapshot?.station_id);
  if (!snapshot || channelId == null || stationId == null) {
    throw new Error('invalid prepared raw collection snapshot');
  }
  if (message.queue != null && !queue) throw new Error('invalid prepared raw collection queue');
  if (queue && !Array.isArray(queue.tracks)) {
    throw new Error('invalid prepared raw collection queue tracks');
  }
  const queueStationId = integer(queue?.station_id);
  if (queueStationId != null && queueStationId !== stationId) {
    throw new Error('prepared raw collection station identity does not match');
  }
  const expectedAlias = String(message.channel_alias || '').trim().toLowerCase();
  const snapshotAlias = String(snapshot.channel_alias || '').trim().toLowerCase();
  if (expectedAlias && snapshotAlias !== expectedAlias) {
    throw new Error('prepared raw collection channel alias does not match');
  }
  return { snapshot, queue };
}

function commentsTaskForMinuteFact(commentTask, body) {
  body.read_model = null;
  return {
    message_type: 'stationhead-comments-task',
    message_version: 2,
    auth: commentTask?.auth || {},
    observed_at: integer(body?.payload?.observedAt) ?? integer(commentTask?.observed_at) ?? Date.now(),
    station_id: integer(body?.payload?.snapshot?.station_id) ?? integer(commentTask?.station_id),
    minute_fact: body,
  };
}

function trustedMinuteFactQueueMessage(body) {
  const payload = objectValue(body?.payload);
  const channelId = integer(body?.channel_id);
  const minuteAt = integer(body?.minute_at);
  if (body?.message_type !== 'minute-fact-job'
      || integer(body?.message_version) !== 1
      || !payload
      || channelId == null
      || minuteAt == null
      || integer(payload?.snapshot?.channel_id) !== channelId) {
    throw new Error('invalid trusted minute fact queue message');
  }
  return { payload, channel_id: channelId };
}

function readModelEnvelopeForMinuteFact(rawMessage, body, trusted = false) {
  const parsed = trusted
    ? trustedMinuteFactQueueMessage(body)
    : parseMinuteFactQueueMessage(body);
  const compact = objectValue(body?.read_model);
  if (!compact) throw new Error('minute fact read model is missing');

  const observedAt = integer(rawMessage?.observed_at) ?? integer(parsed.payload?.observedAt) ?? Date.now();
  const compactChannel = objectValue(compact.channel) || {};
  const compactQueue = objectValue(compact.queue);
  const compactCollector = objectValue(compact.collector) || {};
  let readModel;
  if (trusted) {
    compactChannel.observed_at = observedAt;
    if (compactQueue && !Object.hasOwn(compactQueue, 'value')) {
      compactQueue.value = parsed.payload.queue ?? null;
    }
    compactCollector.last_run_at = observedAt;
    compactCollector.last_success_at = observedAt;
    compactCollector.updated_at = observedAt;
    compact.channel = compactChannel;
    compact.queue = compactQueue;
    compact.collector = compactCollector;
    readModel = compact;
  } else {
    const queue = compactQueue && !Object.hasOwn(compactQueue, 'value')
      ? { ...compactQueue, value: parsed.payload.queue ?? null }
      : compactQueue;
    readModel = {
      ...compact,
      channel: { ...compactChannel, observed_at: observedAt },
      queue,
      collector: {
        ...compactCollector,
        last_run_at: observedAt,
        last_success_at: observedAt,
        updated_at: observedAt,
      },
    };
  }
  return {
    message_type: 'stationhead-read-model',
    message_version: 1,
    observed_at: observedAt,
    job_id: `read-model:${parsed.channel_id}:${observedAt}`,
    read_model: readModel,
    comment_task: {
      observed_at: observedAt,
      station_id: integer(parsed.payload?.snapshot?.station_id),
      auth: rawMessage?.auth || {},
    },
  };
}

function activeIngestEnv(env, message, collection, capture) {
  const active = Object.create(env || null);
  const commentsQueue = env?.COMMENTS_QUEUE;
  const commentTask = {
    observed_at: integer(message?.observed_at),
    station_id: null,
    auth: message?.auth || {},
  };
  Object.defineProperties(active, {
    __shAuthState: { value: message.auth || {}, enumerable: false },
    __shPersistCollectorCredentials: { value: message.persist_credentials !== false, enumerable: false },
    __shPreparedCollection: {
      value: { snapshot: collection.snapshot, queue: collection.queue },
      enumerable: false,
    },
    CHAT_LIMIT: { value: 0, enumerable: true },
    MINUTE_FACT_QUEUE: {
      enumerable: false,
      value: commentsQueue?.send ? {
        send(body, options) {
          if (body && typeof body === 'object') {
            const envelope = readModelEnvelopeForMinuteFact(message, body, true);
            capture.channelId = integer(body.channel_id);
            capture.minuteAt = integer(body.minute_at);
            capture.envelope = envelope;
            return commentsQueue.send(commentsTaskForMinuteFact(commentTask, body), options);
          }
          return commentsQueue.send(body, options);
        },
      } : commentsQueue,
    },
  });
  return active;
}

function capturedReadModelEnvelope(result, capture) {
  const channelId = integer(result?.channel_id);
  const minuteAt = integer(result?.minute_fact_job_minute_at);
  if (channelId == null || minuteAt == null) throw new Error('current minute fact identity is missing');
  return capture?.channelId === channelId && capture?.minuteAt === minuteAt && capture?.envelope
    ? capture.envelope
    : null;
}

function fallbackReadModelEnvelope(env, message, collection) {
  const observedAt = Number(message.observed_at);
  const snapshot = collection.snapshot;
  const queue = minuteFactQueue(collection.queue);
  const channelId = integer(snapshot.channel_id);
  const stationId = integer(snapshot.station_id);
  const collectorId = env.COLLECTOR_ID || 'cloudflare-worker';
  return {
    message_type: 'stationhead-read-model',
    message_version: 1,
    observed_at: observedAt,
    job_id: `read-model:${channelId}:${observedAt}`,
    read_model: {
      channel: {
        channel_id: channelId,
        observed_at: observedAt,
        presentation: readModelPresentation(snapshot),
      },
      queue: {
        station_id: queue?.station_id ?? stationId,
        queue_id: queue?.queue_id ?? null,
        start_time: queue?.start_time ?? null,
        is_paused: queue?.is_paused ?? null,
        value: queue,
      },
      collector: {
        collector_id: collectorId,
        last_run_at: observedAt,
        last_success_at: observedAt,
        last_error_present: false,
        updated_at: observedAt,
      },
    },
    comment_task: {
      observed_at: observedAt,
      station_id: stationId,
      auth: message.auth || {},
    },
  };
}

async function recoverCurrentReadModelEnvelope(env, message, collection, result) {
  const channelId = integer(result?.channel_id);
  const minuteAt = integer(result?.minute_fact_job_minute_at);
  if (channelId == null || minuteAt == null) throw new Error('current minute fact identity is missing');
  const jobId = `minute-fact:${channelId}:${minuteAt}`;
  try {
    const row = await env.DB.prepare(`SELECT payload_json
      FROM sh_minute_fact_outbox
      WHERE job_id=? AND status='pending'
      LIMIT 1`).bind(jobId).first();
    if (row?.payload_json) {
      return readModelEnvelopeForMinuteFact(message, JSON.parse(String(row.payload_json)));
    }
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'current_read_model_outbox_reuse_failed',
      job_id: jobId,
      error: String(error?.message || error).slice(0, 500),
    }));
  }
  return fallbackReadModelEnvelope(env, message, collection);
}

async function enqueueFinalize(env, identity, collectorState, envelope, dependencies = {}) {
  const send = dependencies.sendFinalize
    || ((body) => env.INGEST_FINALIZE_QUEUE.send(body, { contentType: 'json' }));
  if (!dependencies.sendFinalize && !env?.INGEST_FINALIZE_QUEUE?.send) {
    throw new Error('INGEST_FINALIZE_QUEUE binding is missing');
  }
  await send({
    message_type: 'stationhead-ingest-finalize',
    message_version: 1,
    observed_at: identity.observed_at,
    channel_id: identity.channel_id,
    collector_state: collectorState,
    read_model: envelope,
  });
}

async function finalizePreparedIngest(env, result, envelope) {
  if (!env?.INGEST_FINALIZE_QUEUE?.send) {
    await env.READ_MODEL_QUEUE.send(envelope, { contentType: 'json' });
    return false;
  }
  const collectorState = preparedCollectorFinalizeState(result);
  if (!collectorState) throw new Error('prepared collector finalize state is missing');
  await enqueueFinalize(env, {
    observed_at: result.observed_at,
    channel_id: result.channel_id,
  }, collectorState, envelope);
  return true;
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

export async function processIngestFactTask(env, body, dependencies = {}) {
  const fact = validateFactTask(body);
  const rawMessage = {
    observed_at: fact.observedAt,
    auth: fact.auth || {},
  };
  const collection = { snapshot: fact.snapshot, queue: fact.queue ?? null };
  const capture = { channelId: null, minuteAt: null, envelope: null };
  const active = activeIngestEnv(env, rawMessage, collection, capture);
  const handoff = dependencies.handoffMinuteFactJob || handoffMinuteFactJob;
  const minuteFactJob = await handoff(active, {
    observedAt: fact.observedAt,
    snapshot: fact.snapshot,
    queue: fact.queue ?? null,
    comments: fact.comments || {},
  }, fact.options);
  const identity = {
    observed_at: integer(fact.observedAt),
    channel_id: integer(fact.snapshot.channel_id),
    minute_fact_job_minute_at: integer(minuteFactJob?.minute_at),
  };
  const envelope = capturedReadModelEnvelope(identity, capture)
    || await recoverCurrentReadModelEnvelope(env, rawMessage, collection, identity);
  await enqueueFinalize(env, identity, fact.collectorState, envelope, dependencies);
  return {
    event: 'ingest_fact_completed',
    observed_at: identity.observed_at,
    channel_id: identity.channel_id,
    minute_at: identity.minute_fact_job_minute_at,
    minute_fact_job_enqueued: Boolean(minuteFactJob?.enqueued),
    minute_fact_outbox_pending: Boolean(minuteFactJob?.outbox_pending),
  };
}

export async function ingestPreparedRawCollection(env, message) {
  const collection = preparedCollection(message);
  const capture = { channelId: null, minuteAt: null, envelope: null };
  const active = activeIngestEnv(env, message, collection, capture);
  const result = await collectPreparedOnce(active, 'raw-collection-queue');
  const fact = preparedCollectorFactStage(result);
  if (fact) {
    await env.INGEST_FINALIZE_QUEUE.send({
      message_type: 'stationhead-ingest-fact',
      message_version: 1,
      fact,
    }, { contentType: 'json' });
    return result;
  }
  const envelope = capturedReadModelEnvelope(result, capture)
    || await recoverCurrentReadModelEnvelope(env, message, collection, result);
  result.finalize_deferred = await finalizePreparedIngest(env, result, envelope);
  return result;
}
