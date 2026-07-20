import { safeJson } from './playback.js';

export const CHANNEL_READ_MODEL_SQL = `SELECT channel_id,observed_at,presentation_json
FROM sh_channel_read_model
WHERE channel_id=?
LIMIT 1`;

export const QUEUE_READ_MODEL_SQL = `SELECT channel_id,observed_at,station_id,queue_id,
  start_time,is_paused,queue_json
FROM sh_queue_read_model_current
WHERE channel_id=?
LIMIT 1`;

export const COLLECTOR_READ_MODEL_SQL = `SELECT collector_id,last_run_at,last_success_at,
  last_error_present,updated_at
FROM sh_collector_read_model
WHERE collector_id=?
LIMIT 1`;

function parsedQueueJson(value) {
  return safeJson(value, null);
}

function arrayFromParsedQueue(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.queue)) return parsed.queue;
  if (Array.isArray(parsed?.tracks)) return parsed.tracks;
  if (Array.isArray(parsed?.queue_tracks)) return parsed.queue_tracks;
  return [];
}

function registeredQueueItems(parsed, returnedItems) {
  if (!parsed || Array.isArray(parsed)) return returnedItems;
  for (const value of [
    parsed.total_track_count,
    parsed.total_items,
    parsed.queue_total_tracks,
  ]) {
    const total = Number(value);
    if (Number.isFinite(total) && total >= 0) return Math.max(returnedItems, Math.trunc(total));
  }
  return returnedItems;
}

export function presentationFromRow(row) {
  return safeJson(row?.presentation_json, {}) || {};
}

export function queueFromReadModel(row) {
  if (!row) return { latestQueue: null, queue: [], registeredItems: 0 };
  const latestQueue = {
    station_id: row.station_id,
    queue_id: row.queue_id,
    start_time: row.start_time,
    is_paused: row.is_paused,
    observed_at: row.observed_at,
  };
  const parsed = parsedQueueJson(row.queue_json);
  const queue = arrayFromParsedQueue(parsed).map((track, index) => ({
    ...track,
    position: track?.position ?? index,
    station_id: track?.station_id ?? row.station_id,
    queue_id: track?.queue_id ?? row.queue_id,
    start_time: track?.start_time ?? row.start_time,
    observed_at: track?.observed_at ?? row.observed_at,
  }));
  return {
    latestQueue,
    queue,
    registeredItems: registeredQueueItems(parsed, queue.length),
  };
}

export async function loadPublicReadModels(db, channelId) {
  if (!db || channelId == null) return { presentation: null, queue: null };
  const [presentation, queue] = await Promise.all([
    db.prepare(CHANNEL_READ_MODEL_SQL).bind(channelId).first(),
    db.prepare(QUEUE_READ_MODEL_SQL).bind(channelId).first(),
  ]);
  return { presentation, queue };
}
