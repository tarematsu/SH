import { sanitizeFailureDetail } from './collector-failure.js';
import { enqueueMinuteFactJob, minuteFactJobPayload } from './minute-facts-inbox.js';
import { saveMinuteCommentTask } from './minute-comments.js';
import { loadMinuteCommentFacts } from './minute-facts-source.js';
import { minuteBucket } from './minute-facts-store.js';

export const MINUTE_FACT_QUEUE_MESSAGE_TYPE = 'minute-fact-job';
export const MINUTE_FACT_QUEUE_MESSAGE_VERSION = 1;
export const MINUTE_FACT_QUEUE_MAX_MESSAGE_BYTES = 120 * 1024;
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
const messageEncoder = new TextEncoder();
let lastOutboxCleanupMinute = null;

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function invalidMessage(detail) {
  const error = new Error(`invalid minute fact queue message: ${detail}`);
  error.code = 'MINUTE_FACT_QUEUE_INVALID_MESSAGE';
  return error;
}

function serializedMessageFits(serialized) {
  // Three UTF-8 bytes per UTF-16 code unit is a safe upper bound for a
  // JSON.stringify result. Avoid a second full payload traversal for the
  // normal, comfortably-under-limit message.
  if (serialized.length * 3 <= MINUTE_FACT_QUEUE_MAX_MESSAGE_BYTES) return true;
  return messageEncoder.encode(serialized).byteLength <= MINUTE_FACT_QUEUE_MAX_MESSAGE_BYTES;
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

function compactReadModel(readModel, payload) {
  if (!readModel || typeof readModel !== 'object') return null;
  const snapshot = objectValue(payload.snapshot);
  const channel = objectValue(readModel.channel);
  const presentation = objectValue(channel?.presentation);
  const compactPresentation = snapshot && presentation
    ? Object.fromEntries(
      Object.entries(presentation).filter(([key]) => !Object.hasOwn(snapshot, key)),
    )
    : presentation;
  const channelChanged = presentation && compactPresentation
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
    read_model: compactReadModel(options.readModel, payload),
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

export async function flushMinuteFactOutbox(env, options = {}) {
  if (!env?.MINUTE_FACT_QUEUE?.send) {
    return { sent: 0, failed: 0, pending: true, reason: 'queue-binding-missing' };
  }
  const limit = Math.max(1, Math.min(5, integer(options.limit) || 3));
  const rows = await env.DB.prepare(`SELECT job_id,payload_json,attempts
    FROM sh_minute_fact_outbox WHERE status='pending'
    ORDER BY created_at ASC LIMIT ?`).bind(limit).all();
  const summary = { sent: 0, failed: 0, pending: false, current_sent: false };
  let currentAttempted = false;
  for (const row of rows.results || []) {
    const attemptedAt = Date.now();
    try {
      const isCurrent = row.job_id === options.currentJobId;
      if (isCurrent) currentAttempted = true;
      const message = isCurrent && options.currentMessage
        ? options.currentMessage
        : JSON.parse(String(row.payload_json || ''));
      // Queue.send resolves only after the message has been persisted. The
      // status update happens afterwards, so a crash can only cause a safe
      // duplicate delivery, never a lost handoff.
      await env.MINUTE_FACT_QUEUE.send(message, { contentType: 'json' });
      await env.DB.prepare(`UPDATE sh_minute_fact_outbox SET
          status='sent',payload_json='{}',attempts=attempts+1,sent_at=?,last_attempt_at=?,last_error=NULL
        WHERE job_id=? AND status='pending'`)
        .bind(attemptedAt, attemptedAt, row.job_id)
        .run();
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
  const message = minuteFactQueueMessage(input, options);
  const now = Date.now();
  await saveMinuteFactOutboxJob(env, message, now, serializedMessages.get(message));
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
        WHERE status='sent' AND sent_at<? ORDER BY sent_at ASC LIMIT 20
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
  const saveCommentTask = dependencies.saveCommentTask || saveMinuteCommentTask;
  const onCommitted = dependencies.onCommitted || (() => {});
  const summary = { received: 0, enqueued: 0, duplicates: 0, retried: 0, invalid: 0 };
  for (const message of batch?.messages || []) {
    summary.received += 1;
    try {
      const parsed = parseMinuteFactQueueMessage(message.body);
      if (await hasReceipt(env, parsed.job_id)) {
        summary.duplicates += 1;
        message.ack();
        continue;
      }
      const payload = await hydrateMinuteFactComments(env, parsed.payload);
      const result = await enqueue(env, payload, parsed.options);
      await saveReadModels(env, parsed.read_model, parsed.job_id);
      if (parsed.options.collectComments) {
        await saveCommentTask(env, {
          jobId: parsed.job_id,
          payload,
          options: parsed.options,
        });
      }
      await saveReceipt(env, parsed.job_id);
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
