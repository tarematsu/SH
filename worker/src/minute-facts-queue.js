import { sanitizeFailureDetail } from './collector-failure.js';
import { enqueueMinuteFactJob, minuteFactJobPayload } from './minute-facts-inbox.js';
import { loadMinuteCommentFacts } from './minute-facts-source.js';
import { minuteBucket } from './minute-facts-store.js';

export const MINUTE_FACT_QUEUE_MESSAGE_TYPE = 'minute-fact-job';
export const MINUTE_FACT_QUEUE_MESSAGE_VERSION = 1;
export const MINUTE_FACT_POINTER_MESSAGE_TYPE = 'minute-fact-pointer';
export const MINUTE_FACT_POINTER_MESSAGE_VERSION = 1;
export const MINUTE_FACT_QUEUE_MAX_MESSAGE_BYTES = 120 * 1024;
export const MINUTE_FACT_POINTER_MAX_MESSAGE_BYTES = 8 * 1024;
export const MINUTE_FACT_OUTBOX_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sh_minute_fact_outbox (
  job_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  last_attempt_at INTEGER,
  last_error TEXT
)`;

const serializedMessages = new WeakMap();
const pointerSourceMessages = new WeakMap();
const messageEncoder = new TextEncoder();
let lastOutboxCleanupMinute = null;

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function enabled(value) {
  return value === true || value === 1 || /^(1|true|yes|on)$/i.test(String(value || ''));
}

function invalidMessage(detail) {
  const error = new Error(`invalid minute fact queue message: ${detail}`);
  error.code = 'MINUTE_FACT_QUEUE_INVALID_MESSAGE';
  return error;
}

function serializedByteLength(serialized) {
  return messageEncoder.encode(serialized).byteLength;
}

function serializedMessageFits(serialized, limit = MINUTE_FACT_QUEUE_MAX_MESSAGE_BYTES) {
  // Three UTF-8 bytes per UTF-16 code unit is a safe upper bound for a
  // JSON.stringify result. Avoid a second full payload traversal for the
  // normal, comfortably-under-limit message.
  if (serialized.length * 3 <= limit) return true;
  return serializedByteLength(serialized) <= limit;
}

function pointerPayloadBucket(env) {
  return env?.MINUTE_FACT_PAYLOAD_R2 || env?.PAGES_RESPONSE_R2 || null;
}

function pointerStorageKey(message) {
  return `queue-payloads/minute-facts/${message.channel_id}/${message.minute_at}/${message.job_id}.json`;
}

function payloadSizeBucket(bytes) {
  if (bytes < 16 * 1024) return 'lt16k';
  if (bytes < 32 * 1024) return '16k-32k';
  if (bytes < 64 * 1024) return '32k-64k';
  if (bytes < 96 * 1024) return '64k-96k';
  return '96k-120k';
}

function isPointerMessage(value) {
  return value?.message_type === MINUTE_FACT_POINTER_MESSAGE_TYPE;
}

async function hydrateMinuteFactComments(env, payload) {
  const stationId = payload?.snapshot?.station_id;
  if (!env?.BUDDIES_DB || stationId == null) return payload;
  try {
    const facts = await loadMinuteCommentFacts(
      env.BUDDIES_DB,
      stationId,
      payload.observedAt,
      payload.comments,
    );
    if (facts.commentCount == null && facts.commentTotal == null) return payload;
    return {
      ...payload,
      comments: {
        ...(payload.comments || {}),
        commentCount: facts.commentCount,
        commentTotal: facts.commentTotal,
        commentTotalKnown: facts.commentTotal != null,
      },
    };
  } catch {
    return payload;
  }
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function compactReadModel(readModel, payload, presentationAlreadyCompact = false) {
  if (!readModel || typeof readModel !== 'object') return null;
  const snapshot = objectValue(payload.snapshot);
  const channel = objectValue(readModel.channel);
  const presentation = objectValue(channel?.presentation);
  const compactPresentation = presentationAlreadyCompact
    ? presentation
    : snapshot && presentation
    ? Object.fromEntries(
      Object.entries(presentation).filter(([key]) => !Object.hasOwn(snapshot, key)),
    )
    : presentation;
  const channelChanged = !presentationAlreadyCompact && presentation && compactPresentation
    && Object.keys(compactPresentation).length !== Object.keys(presentation).length;
  const queue = objectValue(readModel.queue);
  const queueChanged = queue && payload.queue && Object.hasOwn(queue, 'value');
  if (!channelChanged && !queueChanged) return readModel;
  return {
    ...readModel,
    ...(channelChanged ? { channel: { ...channel, presentation: compactPresentation } } : {}),
    ...(queueChanged ? { queue: (({ value, ...rest }) => rest)(queue) } : {}),
  };
}

function hydrateReadModel(readModel, payload) {
  if (!readModel || typeof readModel !== 'object') return null;
  const snapshot = objectValue(payload.snapshot);
  const channel = objectValue(readModel.channel);
  const presentation = objectValue(channel?.presentation);
  const hydratedPresentation = snapshot && presentation
    ? { ...snapshot, ...presentation }
    : presentation;
  const channelChanged = Boolean(snapshot && presentation);
  const queue = objectValue(readModel.queue);
  const queueChanged = Boolean(queue && payload.queue && !Object.hasOwn(queue, 'value'));
  if (!channelChanged && !queueChanged) return readModel;
  return {
    ...readModel,
    ...(channelChanged ? { channel: { ...channel, presentation: hydratedPresentation } } : {}),
    ...(queueChanged ? { queue: { ...queue, value: payload.queue } } : {}),
  };
}

export function minuteFactQueueMessage(input = {}, options = {}) {
  const payload = minuteFactJobPayload(input);
  const channelId = integer(payload.snapshot?.channel_id);
  if (channelId == null) throw invalidMessage('channel_id is required');
  const minuteAt = minuteBucket(payload.observedAt);
  const jobId = `minute-fact:${channelId}:${minuteAt}`;
  const message = {
    message_type: MINUTE_FACT_QUEUE_MESSAGE_TYPE,
    message_version: MINUTE_FACT_QUEUE_MESSAGE_VERSION,
    job_id: jobId,
    idempotency_key: jobId,
    channel_id: channelId,
    minute_at: minuteAt,
    payload,
    read_model: compactReadModel(options.readModel, payload, options.readModelPresentationOnly === true),
    options: {
      jobKind: options.jobKind || (payload.rebuild ? 'rebuild' : 'live'),
      jobPriority: options.jobPriority ?? (payload.rebuild ? 20 : 100),
      requeueCompleted: options.requeueCompleted === true,
      enrichTrackMetadata: options.enrichTrackMetadata === true,
      collectComments: options.collectComments === true,
    },
  };
  const serialized = JSON.stringify(message);
  if (!serializedMessageFits(serialized)) {
    throw invalidMessage(`message exceeds ${MINUTE_FACT_QUEUE_MAX_MESSAGE_BYTES} bytes`);
  }
  serializedMessages.set(message, serialized);
  return message;
}

export function minuteFactPointerMessage(message, storageKey, payloadBytes) {
  const pointer = {
    message_type: MINUTE_FACT_POINTER_MESSAGE_TYPE,
    message_version: MINUTE_FACT_POINTER_MESSAGE_VERSION,
    job_id: String(message?.job_id || ''),
    channel_id: integer(message?.channel_id),
    minute_at: integer(message?.minute_at),
    payload_version: integer(message?.payload?.payload_version),
    storage_key: String(storageKey || ''),
    payload_bytes: integer(payloadBytes),
  };
  if (!pointer.job_id || pointer.channel_id == null || pointer.minute_at == null) {
    throw invalidMessage('pointer identity is required');
  }
  if (pointer.job_id !== `minute-fact:${pointer.channel_id}:${pointer.minute_at}`) {
    throw invalidMessage('pointer job_id does not match identity');
  }
  if (pointer.payload_version !== 1) throw invalidMessage('pointer payload_version is unsupported');
  if (!pointer.storage_key) throw invalidMessage('pointer storage_key is required');
  if (pointer.payload_bytes == null || pointer.payload_bytes <= 0) {
    throw invalidMessage('pointer payload_bytes is invalid');
  }
  const serialized = JSON.stringify(pointer);
  if (!serializedMessageFits(serialized, MINUTE_FACT_POINTER_MAX_MESSAGE_BYTES)) {
    throw invalidMessage(`pointer exceeds ${MINUTE_FACT_POINTER_MAX_MESSAGE_BYTES} bytes`);
  }
  return pointer;
}

export function parseMinuteFactPointerMessage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidMessage('pointer body must be an object');
  }
  if (body.message_type !== MINUTE_FACT_POINTER_MESSAGE_TYPE
      || integer(body.message_version) !== MINUTE_FACT_POINTER_MESSAGE_VERSION) {
    throw invalidMessage('pointer message is unsupported');
  }
  const pointer = {
    message_type: MINUTE_FACT_POINTER_MESSAGE_TYPE,
    message_version: MINUTE_FACT_POINTER_MESSAGE_VERSION,
    job_id: String(body.job_id || ''),
    channel_id: integer(body.channel_id),
    minute_at: integer(body.minute_at),
    payload_version: integer(body.payload_version),
    storage_key: String(body.storage_key || ''),
    payload_bytes: integer(body.payload_bytes),
  };
  if (!pointer.job_id || pointer.channel_id == null || pointer.minute_at == null) {
    throw invalidMessage('pointer identity is required');
  }
  if (pointer.job_id !== `minute-fact:${pointer.channel_id}:${pointer.minute_at}`) {
    throw invalidMessage('pointer job_id does not match identity');
  }
  if (pointer.payload_version !== 1) throw invalidMessage('pointer payload_version is unsupported');
  if (!pointer.storage_key) throw invalidMessage('pointer storage_key is required');
  if (pointer.payload_bytes == null || pointer.payload_bytes <= 0) {
    throw invalidMessage('pointer payload_bytes is invalid');
  }
  return pointer;
}

export function minuteFactQueueSourceMessage(body) {
  return pointerSourceMessages.get(body) || body;
}

export function parseMinuteFactQueueMessage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidMessage('body must be an object');
  }
  if (body.message_type !== MINUTE_FACT_QUEUE_MESSAGE_TYPE) {
    throw invalidMessage('message_type is unsupported');
  }
  if (integer(body.message_version) !== MINUTE_FACT_QUEUE_MESSAGE_VERSION) {
    throw invalidMessage('message_version is unsupported');
  }
  const payload = minuteFactJobPayload(body.payload);
  const channelId = integer(payload.snapshot?.channel_id);
  if (channelId == null || channelId !== integer(body.channel_id)) {
    throw invalidMessage('channel_id does not match payload');
  }
  const minuteAt = minuteBucket(payload.observedAt);
  if (minuteAt !== integer(body.minute_at)) {
    throw invalidMessage('minute_at does not match payload');
  }
  const jobId = `minute-fact:${channelId}:${minuteAt}`;
  if (body.job_id !== jobId || body.idempotency_key !== jobId) {
    throw invalidMessage('idempotency_key does not match payload');
  }
  return {
    payload,
    options: {
      jobKind: body.options?.jobKind,
      jobPriority: body.options?.jobPriority,
      requeueCompleted: body.options?.requeueCompleted === true,
      enrichTrackMetadata: body.options?.enrichTrackMetadata === true,
      collectComments: body.options?.collectComments === true,
    },
    job_id: jobId,
    read_model: hydrateReadModel(body.read_model, payload),
    channel_id: channelId,
    minute_at: minuteAt,
  };
}

async function ensureMinuteFactPointerTransport(env, message) {
  if (isPointerMessage(message) || !enabled(env?.MINUTE_FACT_POINTER_QUEUE_ENABLED)) return message;
  const bucket = pointerPayloadBucket(env);
  if (!bucket?.put) throw new Error('minute fact payload R2 binding is missing');
  const serialized = serializedMessages.get(message) || JSON.stringify(message);
  const payloadBytes = serializedByteLength(serialized);
  const storageKey = pointerStorageKey(message);
  const pointer = minuteFactPointerMessage(message, storageKey, payloadBytes);
  const pointerJson = JSON.stringify(pointer);
  await bucket.put(storageKey, serialized, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      job_id: message.job_id,
      channel_id: String(message.channel_id),
      minute_at: String(message.minute_at),
      payload_bytes: String(payloadBytes),
    },
  });
  const updated = await env.DB.prepare(`UPDATE sh_minute_fact_outbox SET payload_json=?
    WHERE job_id=? AND status='pending'`)
    .bind(pointerJson, message.job_id)
    .run();
  if (Number(updated?.meta?.changes ?? 1) === 0) {
    throw new Error(`minute fact outbox pointer transition lost for ${message.job_id}`);
  }
  pointerSourceMessages.set(pointer, message);
  console.log(JSON.stringify({
    event: 'minute_fact_queue_pointer_staged',
    job_id: message.job_id,
    channel_id: message.channel_id,
    minute_at: message.minute_at,
    storage_key: storageKey,
    payload_bytes: payloadBytes,
    payload_size_bucket: payloadSizeBucket(payloadBytes),
    pointer_bytes: serializedByteLength(pointerJson),
  }));
  return pointer;
}

async function consumedPointerMarker(env, pointer) {
  const db = env?.BUDDIES_DB || env?.DB;
  if (!db?.prepare) return false;
  const row = await db.prepare(`SELECT status,payload_json FROM sh_minute_fact_outbox
    WHERE job_id=? LIMIT 1`).bind(pointer.job_id).first();
  if (row?.status !== 'sent') return false;
  try {
    const marker = JSON.parse(String(row.payload_json || ''));
    return marker?.consumed === true && marker.storage_key === pointer.storage_key;
  } catch {
    return false;
  }
}

async function resolveMinuteFactQueueMessage(env, body) {
  if (!isPointerMessage(body)) return { ...parseMinuteFactQueueMessage(body), pointer: null, duplicate: false };
  const pointer = parseMinuteFactPointerMessage(body);
  const bucket = pointerPayloadBucket(env);
  if (!bucket?.get) throw new Error('minute fact payload R2 binding is missing');
  const stored = await bucket.get(pointer.storage_key);
  if (!stored) {
    if (await consumedPointerMarker(env, pointer)) {
      return {
        pointer,
        duplicate: true,
        job_id: pointer.job_id,
        channel_id: pointer.channel_id,
        minute_at: pointer.minute_at,
      };
    }
    const error = new Error(`minute fact pointer payload is missing: ${pointer.storage_key}`);
    error.code = 'MINUTE_FACT_POINTER_MISSING';
    throw error;
  }
  const serialized = await stored.text();
  const actualBytes = serializedByteLength(serialized);
  if (actualBytes !== pointer.payload_bytes) {
    const error = new Error(`minute fact pointer payload size mismatch: expected ${pointer.payload_bytes}, got ${actualBytes}`);
    error.code = 'MINUTE_FACT_POINTER_MISMATCH';
    throw error;
  }
  let fullMessage;
  try {
    fullMessage = JSON.parse(serialized);
  } catch {
    throw invalidMessage('pointer payload is not valid JSON');
  }
  const parsed = parseMinuteFactQueueMessage(fullMessage);
  if (parsed.job_id !== pointer.job_id
      || parsed.channel_id !== pointer.channel_id
      || parsed.minute_at !== pointer.minute_at
      || integer(parsed.payload?.payload_version) !== pointer.payload_version) {
    throw invalidMessage('pointer identity does not match stored payload');
  }
  return { ...parsed, pointer, duplicate: false };
}

async function completeMinuteFactPointer(env, pointer) {
  if (!pointer) return false;
  const db = env?.BUDDIES_DB || env?.DB;
  if (!db?.prepare) throw new Error('minute fact outbox DB binding is missing for pointer completion');
  const consumedAt = Date.now();
  const marker = JSON.stringify({
    consumed: true,
    consumed_at: consumedAt,
    storage_key: pointer.storage_key,
    payload_bytes: pointer.payload_bytes,
  });
  const result = await db.prepare(`UPDATE sh_minute_fact_outbox SET
      payload_json=?,last_attempt_at=?,last_error=NULL
    WHERE job_id=? AND status='sent'`)
    .bind(marker, consumedAt, pointer.job_id)
    .run();
  if (Number(result?.meta?.changes ?? 1) === 0) {
    throw new Error(`minute fact pointer completion ledger is missing for ${pointer.job_id}`);
  }
  const bucket = pointerPayloadBucket(env);
  if (bucket?.delete) {
    await bucket.delete(pointer.storage_key).catch((error) => {
      console.warn(JSON.stringify({
        event: 'minute_fact_pointer_delete_failed',
        job_id: pointer.job_id,
        storage_key: pointer.storage_key,
        error: sanitizeFailureDetail(error?.message || error),
      }));
    });
  }
  return true;
}

export async function sendMinuteFactJob(env, input = {}, options = {}) {
  if (!env?.MINUTE_FACT_QUEUE?.send) throw new Error('MINUTE_FACT_QUEUE binding is missing');
  const message = minuteFactQueueMessage(input, options);
  // Awaiting send confirms that Cloudflare has persisted the message. Do not
  // move this onto waitUntil: collection must not report success before the
  // durable handoff has been accepted.
  await env.MINUTE_FACT_QUEUE.send(message, { contentType: 'json' });
  return {
    enqueued: true,
    channel_id: message.channel_id,
    minute_at: message.minute_at,
    job_kind: message.options.jobKind,
    job_priority: message.options.jobPriority,
  };
}

export async function ensureMinuteFactOutboxSchema(env) {
  if (!env?.DB) throw new Error('minute fact outbox DB binding is missing');
  // The table is owned by database/buddies-migrations/002_minute_fact_outbox.sql.
  // Runtime DDL made the collector pay for CREATE TABLE on every fresh D1
  // proxy, so migration state is now the single source of truth.
  return false;
}

async function saveMinuteFactOutboxJob(env, message, now = Date.now(), serialized = null) {
  await env.DB.prepare(`INSERT OR IGNORE INTO sh_minute_fact_outbox(
      job_id,payload_json,status,attempts,created_at,sent_at,last_attempt_at,last_error
    ) VALUES(?,?,'pending',0,?,NULL,NULL,NULL)`)
    .bind(message.job_id, serialized || serializedMessages.get(message) || JSON.stringify(message), now)
    .run();
}

export async function stageMinuteFactOutboxJob(env, input = {}, options = {}) {
  if (!env?.DB?.prepare) throw new Error('minute fact outbox DB binding is missing');
  const message = minuteFactQueueMessage(input, options);
  const now = Date.now();
  await saveMinuteFactOutboxJob(env, message, now, serializedMessages.get(message));
  return {
    message,
    staged_at: now,
    enqueued: false,
    outbox_pending: true,
    channel_id: message.channel_id,
    minute_at: message.minute_at,
    job_kind: message.options.jobKind,
    job_priority: message.options.jobPriority,
  };
}

export async function flushMinuteFactOutbox(env, options = {}) {
  if (!env?.MINUTE_FACT_QUEUE?.send) {
    return { sent: 0, failed: 0, pending: true, reason: 'queue-binding-missing' };
  }
  const limit = Math.max(1, Math.min(5, integer(options.limit) || 3));
  const inlineMessageJobId = options.currentMessage && options.currentJobId != null
    ? options.currentJobId
    : null;
  const rows = await env.DB.prepare(`SELECT job_id,
    CASE WHEN job_id=? THEN NULL ELSE payload_json END AS payload_json,
    attempts
    FROM sh_minute_fact_outbox WHERE status='pending'
    ORDER BY created_at ASC LIMIT ?`).bind(inlineMessageJobId, limit).all();
  const summary = { sent: 0, failed: 0, pending: false, current_sent: false };
  let currentAttempted = false;
  for (const row of rows.results || []) {
    const attemptedAt = Date.now();
    try {
      const isCurrent = row.job_id === options.currentJobId;
      if (isCurrent) currentAttempted = true;
      let message = isCurrent && options.currentMessage
        ? options.currentMessage
        : JSON.parse(String(row.payload_json || ''));
      message = await ensureMinuteFactPointerTransport(env, message);
      // Queue.send resolves only after the message has been persisted. The
      // status update happens afterwards, so a crash can only cause a safe
      // duplicate delivery, never a lost handoff.
      await env.MINUTE_FACT_QUEUE.send(message, { contentType: 'json' });
      if (isPointerMessage(message)) {
        await env.DB.prepare(`UPDATE sh_minute_fact_outbox SET
            status='sent',attempts=attempts+1,sent_at=?,last_attempt_at=?,last_error=NULL
          WHERE job_id=? AND status='pending'`)
          .bind(attemptedAt, attemptedAt, row.job_id)
          .run();
      } else {
        await env.DB.prepare(`UPDATE sh_minute_fact_outbox SET
            status='sent',payload_json='{}',attempts=attempts+1,sent_at=?,last_attempt_at=?,last_error=NULL
          WHERE job_id=? AND status='pending'`)
          .bind(attemptedAt, attemptedAt, row.job_id)
          .run();
      }
      summary.sent += 1;
      if (isCurrent) summary.current_sent = true;
    } catch (error) {
      summary.failed += 1;
      summary.pending = true;
      await env.DB.prepare(`UPDATE sh_minute_fact_outbox SET
          attempts=attempts+1,last_attempt_at=?,last_error=?
        WHERE job_id=? AND status='pending'`)
        .bind(attemptedAt, sanitizeFailureDetail(error?.message || error).slice(0, 800), row.job_id)
        .run()
        .catch(() => {});
      console.warn(JSON.stringify({
        event: 'minute_fact_outbox_send_failed',
        job_id: String(row.job_id || ''),
        error: sanitizeFailureDetail(error?.message || error),
      }));
      // Preserve ordering and avoid hammering an unavailable Queue.
      break;
    }
  }
  if (rows.results?.length >= limit) {
    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sh_minute_fact_outbox WHERE status='pending'",
    ).first();
    summary.pending = Number(pending?.count || 0) > 0;
  } else {
    summary.pending = summary.failed > 0;
  }
  if (options.currentJobId && !currentAttempted) {
    const current = await env.DB.prepare(
      'SELECT status FROM sh_minute_fact_outbox WHERE job_id=? LIMIT 1',
    ).bind(String(options.currentJobId)).first();
    summary.current_sent = current?.status === 'sent';
  }
  return summary;
}

export async function handoffMinuteFactJob(env, input = {}, options = {}) {
  const staged = await stageMinuteFactOutboxJob(env, input, options);
  const { message } = staged;
  const now = staged.staged_at;
  const delivery = await flushMinuteFactOutbox(env, {
    limit: options.flushLimit,
    currentJobId: message.job_id,
    currentMessage: message,
  });
  const cleanupMinute = Math.floor(now / 60_000);
  const utcDate = new Date(now);
  if (utcDate.getUTCHours() === 0
      && utcDate.getUTCMinutes() === 0
      && lastOutboxCleanupMinute !== cleanupMinute) {
    lastOutboxCleanupMinute = cleanupMinute;
    await env.DB.prepare(`DELETE FROM sh_minute_fact_outbox WHERE job_id IN (
        SELECT job_id FROM sh_minute_fact_outbox
        WHERE status='sent' AND sent_at<?
          AND (payload_json='{}' OR payload_json LIKE '%"consumed":true%')
        ORDER BY sent_at ASC LIMIT 20
      )`).bind(now - 7 * 24 * 60 * 60_000).run().catch(() => {});
  }
  return {
    enqueued: delivery.current_sent,
    outbox_pending: delivery.pending,
    channel_id: message.channel_id,
    minute_at: message.minute_at,
    job_kind: message.options.jobKind,
    job_priority: message.options.jobPriority,
  };
}

function retryDelaySeconds(attempts) {
  const exponent = Math.max(0, Math.min(6, (integer(attempts) || 1) - 1));
  return Math.min(15 * 60, 5 * (2 ** exponent));
}

export async function consumeMinuteFactBatch(batch, env, dependencies = {}) {
  const enqueue = dependencies.enqueue || enqueueMinuteFactJob;
  const saveReadModels = dependencies.saveReadModels || (async () => {});
  const hasReceipt = dependencies.hasReceipt || (async () => false);
  const saveReceipt = dependencies.saveReceipt || (async () => {});
  const saveCommentTask = dependencies.saveCommentTask || null;
  const onCommitted = dependencies.onCommitted || (() => {});
  const summary = { received: 0, enqueued: 0, duplicates: 0, retried: 0, invalid: 0 };
  for (const message of batch?.messages || []) {
    summary.received += 1;
    try {
      const parsed = await resolveMinuteFactQueueMessage(env, message.body);
      if (parsed.duplicate) {
        summary.duplicates += 1;
        message.ack();
        continue;
      }
      if (await hasReceipt(env, parsed.job_id)) {
        await completeMinuteFactPointer(env, parsed.pointer);
        summary.duplicates += 1;
        message.ack();
        continue;
      }
      const payload = await hydrateMinuteFactComments(env, parsed.payload);
      const result = await enqueue(env, payload, parsed.options);
      await saveReadModels(env, parsed.read_model, parsed.job_id);
      if (parsed.options.collectComments && saveCommentTask) {
        await saveCommentTask(env, {
          jobId: parsed.job_id,
          payload,
          options: parsed.options,
        });
      }
      await saveReceipt(env, parsed.job_id);
      await completeMinuteFactPointer(env, parsed.pointer);
      if (result?.enqueued) summary.enqueued += 1;
      else summary.duplicates += 1;
      message.ack();
      try {
        onCommitted({
          jobId: parsed.job_id,
          payload,
          options: parsed.options,
        });
      } catch (error) {
        console.warn(JSON.stringify({
          event: 'minute_fact_post_commit_hook_failed',
          job_id: parsed.job_id,
          error: sanitizeFailureDetail(error?.message || error),
        }));
      }
    } catch (error) {
      if (error?.code === 'MINUTE_FACT_QUEUE_INVALID_MESSAGE') {
        summary.invalid += 1;
        message.ack();
        console.error(JSON.stringify({
          event: 'minute_fact_queue_message_invalid',
          message_id: String(message.id || ''),
          error: sanitizeFailureDetail(error?.message || error),
        }));
        continue;
      }
      summary.retried += 1;
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      console.warn(JSON.stringify({
        event: 'minute_fact_queue_message_retry',
        message_id: String(message.id || ''),
        attempts: integer(message.attempts) || 1,
        error: sanitizeFailureDetail(error?.message || error),
      }));
    }
  }
  console.log(JSON.stringify({ event: 'minute_fact_queue_summary', ...summary }));
  return summary;
}
