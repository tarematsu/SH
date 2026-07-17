import {
  attachReadModelTrackMetadata,
  loadReadModelTrackMetadata,
  preserveReadModelTrackMetadata,
  queueNeedsPreviousTrackMetadata,
} from './minute-facts-read-model.js';

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function timestamp(value) {
  const numeric = integer(value);
  if (numeric != null) return numeric;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanCode(value) {
  if (value == null) return null;
  if (value === false || value === 0 || String(value).toLowerCase() === 'false') return 0;
  return 1;
}

function normalizedIsrc(value) {
  return String(value || '').trim().toUpperCase();
}

function queueValueFromJson(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function prepareReadModelForWrite(env, readModel) {
  if (!readModel || typeof readModel !== 'object') throw new Error('minute fact read model payload is missing');
  let prepared = readModel;
  const queue = prepared?.queue?.value;
  if (queue?.tracks?.length) {
    const incomplete = queue.tracks.filter((track) => (
      !track?.title || !track?.artist || !track?.thumbnail_url
    ));
    const spotifyIds = [...new Set(
      incomplete.map((track) => String(track?.spotify_id || '').trim()).filter(Boolean),
    )].slice(0, 80);
    const isrcs = [...new Set(
      incomplete.map((track) => normalizedIsrc(track?.isrc)).filter(Boolean),
    )].slice(0, 80);
    if (spotifyIds.length || isrcs.length) {
      const rows = await loadReadModelTrackMetadata(env, spotifyIds, isrcs);
      const hydrated = attachReadModelTrackMetadata(queue, rows);
      if (hydrated !== queue) prepared = { ...prepared, queue: { ...prepared.queue, value: hydrated } };
    }
  }

  const stableQueue = prepared?.queue?.value;
  const channelId = integer(prepared?.channel?.channel_id);
  if (!env?.MINUTE_DB || channelId == null || !stableQueue?.tracks?.length
      || !queueNeedsPreviousTrackMetadata(stableQueue)) return prepared;
  const previous = await env.MINUTE_DB.prepare(`SELECT queue_id,start_time,queue_json
    FROM sh_queue_read_model_current WHERE channel_id=? LIMIT 1`).bind(channelId).first();
  if (!previous
      || integer(previous.queue_id) !== integer(prepared.queue.queue_id)
      || timestamp(previous.start_time) !== timestamp(prepared.queue.start_time)) return prepared;
  const previousQueue = queueValueFromJson(previous.queue_json);
  const preserved = preserveReadModelTrackMetadata(stableQueue, previousQueue);
  return preserved === stableQueue
    ? prepared
    : { ...prepared, queue: { ...prepared.queue, value: preserved } };
}

export async function writePreparedReadModel(env, readModel) {
  if (!env?.MINUTE_DB) throw new Error('minute fact read model MINUTE_DB binding is missing');
  if (!readModel || typeof readModel !== 'object') throw new Error('minute fact read model payload is missing');
  const channel = readModel.channel || {};
  const queue = readModel.queue || {};
  const collector = readModel.collector || {};
  const channelId = integer(channel.channel_id);
  const observedAt = integer(channel.observed_at);
  if (channelId == null || observedAt == null) throw new Error('channel read model identity is missing');
  const collectorId = String(collector.collector_id || '').trim();
  if (!collectorId) throw new Error('collector read model identity is missing');

  await env.MINUTE_DB.batch([
    env.MINUTE_DB.prepare(`INSERT INTO sh_channel_read_model(channel_id,observed_at,presentation_json)
      VALUES(?,?,?) ON CONFLICT(channel_id) DO UPDATE SET
        observed_at=excluded.observed_at,presentation_json=excluded.presentation_json
      WHERE excluded.observed_at>=sh_channel_read_model.observed_at`)
      .bind(channelId, observedAt, JSON.stringify(channel.presentation || {})),
    env.MINUTE_DB.prepare(`INSERT INTO sh_queue_read_model_current(
        channel_id,observed_at,station_id,queue_id,start_time,is_paused,queue_json
      ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET
        observed_at=excluded.observed_at,station_id=excluded.station_id,queue_id=excluded.queue_id,
        start_time=excluded.start_time,is_paused=excluded.is_paused,queue_json=excluded.queue_json
      WHERE excluded.observed_at>=sh_queue_read_model_current.observed_at`)
      .bind(
        channelId,
        observedAt,
        integer(queue.station_id),
        integer(queue.queue_id),
        timestamp(queue.start_time),
        booleanCode(queue.is_paused),
        JSON.stringify(queue.value || null),
      ),
    env.MINUTE_DB.prepare(`INSERT INTO sh_collector_read_model(
        collector_id,last_run_at,last_success_at,last_error_present,updated_at
      ) VALUES(?,?,?,?,?) ON CONFLICT(collector_id) DO UPDATE SET
        last_run_at=excluded.last_run_at,last_success_at=excluded.last_success_at,
        last_error_present=excluded.last_error_present,updated_at=excluded.updated_at
      WHERE excluded.updated_at>=sh_collector_read_model.updated_at`)
      .bind(
        collectorId,
        integer(collector.last_run_at),
        integer(collector.last_success_at),
        Number(Boolean(collector.last_error_present)),
        integer(collector.updated_at) ?? observedAt,
      ),
  ]);
}
