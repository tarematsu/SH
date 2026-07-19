export const MINUTE_DERIVE_MESSAGE_TYPE = 'minute-fact-derive';
export const MINUTE_DERIVE_MESSAGE_VERSION = 1;

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
  const queue = env?.MINUTE_LIVE_DERIVE_QUEUE || env?.MINUTE_DERIVE_QUEUE;
  if (!queue?.send) throw new Error('minute live derive Queue binding is missing');
  const trigger = minuteDeriveTrigger({ ...input, job_kind: input?.job_kind || 'live' });
  await queue.send(trigger, { contentType: 'json' });
  return trigger;
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
  const [pending, expired] = await Promise.all([
    env.MINUTE_DB.prepare(`SELECT id,channel_id,minute_at,job_kind,job_priority
      FROM sh_minute_fact_jobs
      WHERE status='pending' AND next_attempt_at<=?
      ORDER BY job_priority DESC,minute_at ASC,id ASC
      LIMIT ?`).bind(now, limit).all(),
    env.MINUTE_DB.prepare(`SELECT id,channel_id,minute_at,job_kind,job_priority
      FROM sh_minute_fact_jobs
      WHERE status='processing' AND lease_until<?
      ORDER BY lease_until ASC,id ASC
      LIMIT ?`).bind(now, limit).all(),
  ]);
  return [...(pending.results || []), ...(expired.results || [])]
    .sort(dispatchOrder)
    .slice(0, limit)
    .map(minuteDeriveTrigger);
}
