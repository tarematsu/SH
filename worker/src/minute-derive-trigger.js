import { historicalRebuildEnabled } from './historical-rebuild-policy.js';

export const MINUTE_DERIVE_MESSAGE_TYPE = 'minute-fact-derive';
export const MINUTE_DERIVE_MESSAGE_VERSION = 1;
export const MINUTE_DIRECT_LIVE_DERIVE_MESSAGE_TYPE = 'minute-fact-live-direct';
export const MINUTE_DIRECT_LIVE_DERIVE_MESSAGE_VERSION = 1;

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = integer(value);
  if (parsed == null || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function deriveJobKind(value) {
  const parsed = String(value || '').trim().toLowerCase();
  return parsed === 'live' || parsed === 'rebuild' ? parsed : null;
}

function invalidTrigger(detail) {
  const error = new Error(`invalid minute derive trigger: ${detail}`);
  error.code = 'MINUTE_DERIVE_INVALID_TRIGGER';
  return error;
}

export function minuteDeriveTrigger(input = {}) {
  const channelId = integer(input.channel_id);
  const minuteAt = integer(input.minute_at);
  if (channelId == null) throw invalidTrigger('channel_id is required');
  if (minuteAt == null) throw invalidTrigger('minute_at is required');
  const jobKind = deriveJobKind(input.job_kind);
  return {
    message_type: MINUTE_DERIVE_MESSAGE_TYPE,
    message_version: MINUTE_DERIVE_MESSAGE_VERSION,
    job_id: `minute-fact:${channelId}:${minuteAt}`,
    channel_id: channelId,
    minute_at: minuteAt,
    ...(jobKind ? { job_kind: jobKind } : {}),
  };
}

export function parseMinuteDeriveTrigger(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidTrigger('body must be an object');
  }
  if (body.message_type !== MINUTE_DERIVE_MESSAGE_TYPE) {
    throw invalidTrigger('message_type is unsupported');
  }
  if (integer(body.message_version) !== MINUTE_DERIVE_MESSAGE_VERSION) {
    throw invalidTrigger('message_version is unsupported');
  }
  const trigger = minuteDeriveTrigger(body);
  if (body.job_id !== trigger.job_id) throw invalidTrigger('job_id does not match');
  return trigger;
}

export async function enqueueMinuteDeriveTrigger(env, input) {
  const jobKind = deriveJobKind(input?.job_kind) || 'live';
  const queue = jobKind === 'rebuild'
    ? env?.MINUTE_DERIVE_QUEUE
    : env?.MINUTE_LIVE_DERIVE_QUEUE || env?.MINUTE_DERIVE_QUEUE;
  if (!queue?.send) {
    throw new Error(jobKind === 'rebuild'
      ? 'minute rebuild derive Queue binding is missing'
      : 'minute live derive Queue binding is missing');
  }
  const trigger = minuteDeriveTrigger({ ...input, job_kind: jobKind });
  await queue.send(trigger, { contentType: 'json' });
  return trigger;
}

export function minuteDirectLiveDeriveMessage(payload = {}) {
  const channelId = integer(payload?.snapshot?.channel_id);
  const observedAt = integer(payload?.observedAt);
  if (channelId == null) throw invalidTrigger('direct live channel_id is required');
  if (observedAt == null) throw invalidTrigger('direct live observedAt is required');
  if (integer(payload?.payload_version) !== 1) {
    throw invalidTrigger('direct live payload_version is unsupported');
  }
  const minuteAt = Math.floor(observedAt / 60_000) * 60_000;
  const jobId = `minute-fact:${channelId}:${minuteAt}`;
  return {
    message_type: MINUTE_DIRECT_LIVE_DERIVE_MESSAGE_TYPE,
    message_version: MINUTE_DIRECT_LIVE_DERIVE_MESSAGE_VERSION,
    job_id: jobId,
    idempotency_key: jobId,
    channel_id: channelId,
    minute_at: minuteAt,
    payload,
  };
}

export function parseDirectLiveMinuteDeriveMessage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidTrigger('direct live body must be an object');
  }
  if (body.message_type !== MINUTE_DIRECT_LIVE_DERIVE_MESSAGE_TYPE
      || integer(body.message_version) !== MINUTE_DIRECT_LIVE_DERIVE_MESSAGE_VERSION) {
    throw invalidTrigger('direct live message is unsupported');
  }
  const expected = minuteDirectLiveDeriveMessage(body.payload);
  if (body.job_id !== expected.job_id
      || body.idempotency_key !== expected.idempotency_key
      || integer(body.channel_id) !== expected.channel_id
      || integer(body.minute_at) !== expected.minute_at) {
    throw invalidTrigger('direct live identity does not match payload');
  }
  return expected;
}

export async function enqueueDirectLiveMinuteDerive(env, payload) {
  const queue = env?.MINUTE_LIVE_DERIVE_QUEUE || env?.MINUTE_DERIVE_QUEUE;
  if (!queue?.send) throw new Error('minute live derive Queue binding is missing');
  const message = minuteDirectLiveDeriveMessage(payload);
  await queue.send(message, { contentType: 'json' });
  return {
    enqueued: true,
    direct: true,
    channel_id: message.channel_id,
    minute_at: message.minute_at,
    job_kind: 'live',
    job_priority: 100,
  };
}

function dispatchOrder(left, right) {
  const priority = Number(right?.job_priority || 0) - Number(left?.job_priority || 0);
  if (priority) return priority;
  const minute = Number(left?.minute_at || 0) - Number(right?.minute_at || 0);
  if (minute) return minute;
  return Number(left?.id || 0) - Number(right?.id || 0);
}

export async function pendingMinuteDeriveTriggers(env, options = {}) {
  if (!env?.MINUTE_DB) throw new Error('minute derive MINUTE_DB binding is missing');
  const now = integer(options.now) ?? Date.now();
  const limit = positiveInteger(options.limit, 5, 20);
  const kindFilter = historicalRebuildEnabled(env) ? '' : " AND job_kind!='rebuild'";
  const [pending, expired] = await Promise.all([
    env.MINUTE_DB.prepare(`SELECT id,channel_id,minute_at,job_kind,job_priority
      FROM sh_minute_fact_jobs INDEXED BY idx_sh_minute_fact_jobs_pending_ready
      WHERE status='pending' AND next_attempt_at<=?${kindFilter}
      ORDER BY next_attempt_at ASC,job_priority DESC,minute_at ASC,id ASC
      LIMIT ?`).bind(now, limit).all(),
    env.MINUTE_DB.prepare(`SELECT id,channel_id,minute_at,job_kind,job_priority
      FROM sh_minute_fact_jobs INDEXED BY idx_sh_minute_fact_jobs_processing_lease
      WHERE status='processing' AND lease_until<?${kindFilter}
      ORDER BY lease_until ASC,id ASC
      LIMIT ?`).bind(now, limit).all(),
  ]);
  return [...(pending.results || []), ...(expired.results || [])]
    .sort(dispatchOrder)
    .slice(0, limit)
    .map(minuteDeriveTrigger);
}
