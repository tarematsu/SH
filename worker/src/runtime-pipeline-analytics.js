const MINUTE_MS = 60_000;
const DEFAULT_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 60;

export const RUNTIME_ANALYTICS_BINDING = 'RUNTIME_ANALYTICS_STREAM';
export const RUNTIME_ANALYTICS_RECORD_MAX_BYTES = 4_096;

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.trunc(parsed) <= 0) return fallback;
  return Math.min(maximum, Math.trunc(parsed));
}

export function runtimeAnalyticsIntervalMinutes(env = {}) {
  return positiveInteger(
    env.PIPELINE_ANALYTICS_INTERVAL_MINUTES,
    DEFAULT_INTERVAL_MINUTES,
    MAX_INTERVAL_MINUTES,
  );
}

export function runtimeAnalyticsDue(timestamp, env = {}) {
  const scheduledAt = Number(timestamp);
  if (!Number.isFinite(scheduledAt) || scheduledAt < 0) return false;
  const absoluteMinute = Math.floor(scheduledAt / MINUTE_MS);
  return absoluteMinute % runtimeAnalyticsIntervalMinutes(env) === 0;
}

function messageByType(messages, type) {
  return (messages || []).find((message) => message?.message_type === type) || null;
}

export function runtimeScheduleAnalyticsRecord(messages, scheduledAt) {
  const maintenance = messageByType(messages, 'monitor-maintenance-task');
  const minuteGate = messageByType(messages, 'runtime-minute-maintenance-gate-dispatch');
  return {
    schema_version: 1,
    event_type: 'runtime_schedule',
    worker: 'sh-runtime-orchestrator',
    observed_at: new Date(scheduledAt).toISOString(),
    scheduled_at: Math.trunc(scheduledAt),
    task_count: Array.isArray(messages) ? messages.length : 0,
    raw_collection: Boolean(messageByType(messages, 'raw-collection-task')),
    minute_recovery: Boolean(messageByType(messages, 'runtime-minute-recovery-dispatch')),
    minute_gate: String(minuteGate?.task || ''),
    stream_prediction: Boolean(messageByType(messages, 'runtime-stream-prediction-dispatch')),
    maintenance_cron: String(maintenance?.cron || ''),
  };
}

export function runtimeAnalyticsRecordBytes(record) {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength;
}

export async function publishRuntimeScheduleAnalytics(
  env,
  messages,
  scheduledAt,
  dependencies = {},
) {
  const stream = dependencies.stream || env?.[RUNTIME_ANALYTICS_BINDING];
  if (typeof stream?.send !== 'function') return { skipped: true, reason: 'binding-missing' };
  if (!runtimeAnalyticsDue(scheduledAt, env)) return { skipped: true, reason: 'interval' };

  const record = runtimeScheduleAnalyticsRecord(messages, scheduledAt);
  const bytes = runtimeAnalyticsRecordBytes(record);
  if (bytes > RUNTIME_ANALYTICS_RECORD_MAX_BYTES) {
    throw new Error(`runtime analytics record exceeded ${RUNTIME_ANALYTICS_RECORD_MAX_BYTES} bytes`);
  }
  await stream.send([record]);
  return { skipped: false, records: 1, bytes };
}
