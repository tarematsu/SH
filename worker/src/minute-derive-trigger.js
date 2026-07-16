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
  return {
    message_type: MINUTE_DERIVE_MESSAGE_TYPE,
    message_version: MINUTE_DERIVE_MESSAGE_VERSION,
    job_id: `minute-fact:${channelId}:${minuteAt}`,
    channel_id: channelId,
    minute_at: minuteAt,
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
  if (!env?.MINUTE_DERIVE_QUEUE?.send) throw new Error('MINUTE_DERIVE_QUEUE binding is missing');
  const trigger = minuteDeriveTrigger(input);
  await env.MINUTE_DERIVE_QUEUE.send(trigger, { contentType: 'json' });
  return trigger;
}

export async function pendingMinuteDeriveTriggers(env, options = {}) {
  if (!env?.MINUTE_DB) throw new Error('minute derive MINUTE_DB binding is missing');
  const now = integer(options.now) ?? Date.now();
  const limit = positiveInteger(options.limit, 5, 20);
  const result = await env.MINUTE_DB.prepare(`SELECT channel_id,minute_at
    FROM sh_minute_fact_jobs
    WHERE (status='pending' AND next_attempt_at<=?)
       OR (status='processing' AND COALESCE(lease_until,0)<?)
    ORDER BY job_priority DESC,minute_at ASC,id ASC
    LIMIT ?`)
    .bind(now, now, limit)
    .all();
  return (result.results || []).map(minuteDeriveTrigger);
}
