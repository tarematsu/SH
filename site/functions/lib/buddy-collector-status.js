import { num } from './api-utils.js';

export const BUDDY_COLLECTOR_STATUS_SQL = `SELECT last_seen_at,metadata_json
  FROM sh_collector_heartbeats WHERE collector_id=? LIMIT 1`;

function safeJson(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function emptyStatus(status = 'never') {
  return {
    status,
    last_attempt_at: null,
    last_success_at: null,
    last_error: null,
    failure_code: null,
    failure_stage: null,
    failure_summary: null,
    failure_hint: null,
    tracks: null,
  };
}

export function buddyCollectorId(alias = 'buddy46') {
  return `${String(alias || 'buddy46').trim().toLowerCase()}-playback`;
}

export function buddyCollectorStatus(row) {
  if (!row) return emptyStatus('never');
  const metadata = safeJson(row.metadata_json);
  if (!metadata || !['ok', 'error'].includes(metadata.status)) {
    return {
      ...emptyStatus('unknown'),
      last_attempt_at: num(row.last_seen_at),
      last_error: 'collector status metadata is unavailable',
      failure_code: 'COLLECTOR_STATUS_INVALID',
    };
  }
  return {
    status: metadata.status,
    last_attempt_at: num(metadata.last_attempt_at) ?? num(row.last_seen_at),
    last_success_at: num(metadata.last_success_at),
    last_error: metadata.last_error || null,
    failure_code: metadata.failure_code || null,
    failure_stage: metadata.failure_stage || null,
    failure_summary: metadata.failure_summary || null,
    failure_hint: metadata.failure_hint || null,
    tracks: num(metadata.tracks),
  };
}

export async function loadBuddyCollectorStatus(db, alias) {
  try {
    const row = await db.prepare(BUDDY_COLLECTOR_STATUS_SQL)
      .bind(buddyCollectorId(alias))
      .first();
    return buddyCollectorStatus(row);
  } catch (error) {
    if (/no such table:\s*sh_collector_heartbeats/i.test(String(error?.message || error))) {
      return buddyCollectorStatus(null);
    }
    return {
      ...emptyStatus('unknown'),
      last_error: 'collector status could not be read',
      failure_code: 'D1_READ_ERROR',
      failure_stage: 'd1_read_collector_state',
    };
  }
}

export function attachBuddyCollectorStatus(payload, collector) {
  const observedAt = num(payload?.latest_observed_at);
  const failedAfterData = collector?.status === 'error'
    && (num(collector.last_attempt_at) ?? 0) >= (observedAt ?? 0);
  const neverCollected = collector?.status === 'never' && observedAt == null;
  const stale = Boolean(payload?.stale || failedAfterData || neverCollected);
  const queue = stale
    ? (payload?.queue || []).map((track) => ({ ...track, is_current: false }))
    : (payload?.queue || []);
  const queueStatus = payload?.queue_status
    ? {
        ...payload.queue_status,
        playing: stale ? false : payload.queue_status.playing,
        current_index: stale ? -1 : payload.queue_status.current_index,
        progress_ms: stale ? 0 : payload.queue_status.progress_ms,
        anchor_at: stale ? null : payload.queue_status.anchor_at,
      }
    : null;

  return {
    ...payload,
    playing: stale ? false : payload.playing,
    stale,
    collector,
    queue_status: queueStatus,
    queue,
  };
}
