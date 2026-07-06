import { json, num } from '../lib/api-utils.js';
import {
  attachBuddyCollectorStatus,
  loadBuddyCollectorStatus,
} from '../lib/buddy-collector-status.js';
import { parseLatestQueueRows } from '../lib/latest-queue.js';
import { computePlayback, normalizePlaybackTrack } from '../lib/playback.js';
import { hostIdentity, queueRevision, stateFromQueue } from '../lib/queue-state.js';

const CACHE_CONTROL = 'public, max-age=5, s-maxage=10, stale-while-revalidate=30';
const DEFAULT_CHANNEL_ALIAS = 'buddies';
const SECONDARY_STALE_MS = 15 * 60_000;

export { computePlayback };

export const SECONDARY_PLAYBACK_SQL = `SELECT channel_alias,station_id,queue_id,start_time,
  is_paused,is_broadcasting,host_account_id,host_handle,state_hash,queue_json,
  checked_at,changed_at
FROM sh_playback_channel_current WHERE channel_alias=? LIMIT 1`;

export const PLAYBACK_FEED_SQL = `WITH latest_channel AS (
  SELECT observed_at,station_id,is_broadcasting,host_account_id,host_handle,broadcast_start_time
  FROM sh_channel_snapshots
  ORDER BY observed_at DESC,id DESC
  LIMIT 1
), latest_queue AS (
  SELECT station_id,queue_id,start_time,is_paused,observed_at
  FROM sh_queue_snapshots
  WHERE station_id=(SELECT station_id FROM latest_channel)
  ORDER BY observed_at DESC,id DESC
  LIMIT 1
)
SELECT
  channel.observed_at AS channel_observed_at,
  channel.station_id AS channel_station_id,
  channel.is_broadcasting,channel.host_account_id,channel.host_handle,
  channel.broadcast_start_time,
  queue.station_id AS queue_station_id,queue.queue_id,
  queue.start_time AS queue_start_time,queue.is_paused AS queue_is_paused,
  queue.observed_at AS queue_observed_at,
  items.observed_at AS item_observed_at,
  items.position,items.queue_track_id,items.stationhead_track_id,items.spotify_id,
  items.apple_music_id,items.deezer_id,items.isrc,items.duration_ms,
  items.preview_url,items.bite_count,
  metadata.title,metadata.artist,metadata.display_title,metadata.thumbnail_url,
  metadata.spotify_url,metadata.fetched_at AS metadata_fetched_at,
  metadata.raw_json AS metadata_raw_json
FROM latest_channel channel
LEFT JOIN latest_queue queue ON 1=1
LEFT JOIN sh_queue_items items
  ON items.station_id=queue.station_id AND items.start_time=queue.start_time
LEFT JOIN sh_track_metadata metadata ON metadata.spotify_id=items.spotify_id
ORDER BY items.position ASC
LIMIT 80`;

export function parsePlaybackFeedRows(rows = []) {
  const head = rows[0] || null;
  const latest = head ? {
    observed_at: head.channel_observed_at,
    station_id: head.channel_station_id,
    is_broadcasting: head.is_broadcasting,
    host_account_id: head.host_account_id,
    host_handle: head.host_handle,
    broadcast_start_time: head.broadcast_start_time,
  } : null;
  const { latestQueue, queue } = parseLatestQueueRows(rows);
  return { latest, latestQueue, queue };
}

function requestedChannel(request) {
  if (!request?.url) return DEFAULT_CHANNEL_ALIAS;
  const value = new URL(request.url).searchParams.get('channel');
  return String(value || DEFAULT_CHANNEL_ALIAS).trim().toLowerCase() || DEFAULT_CHANNEL_ALIAS;
}

function parseQueueJson(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storedBoolean(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null || value === '') return false;
  const normalized = String(value).trim().toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(normalized);
}

function missingPlaybackTable(error) {
  return /no such table:\s*sh_playback_channel_current/i.test(String(error?.message || error));
}

function emptySecondaryPayload(alias, generatedAt, setupRequired = false) {
  return {
    ok: true,
    channel_alias: alias || null,
    generated_at: generatedAt,
    latest_observed_at: null,
    queue_observed_at: null,
    changed_at: null,
    station_id: null,
    is_broadcasting: false,
    playing: false,
    stale: true,
    setup_required: setupRequired,
    queue_revision: null,
    queue_status: null,
    queue: [],
  };
}

export function secondaryPlaybackPayload(row, generatedAt = Date.now()) {
  const alias = String(row?.channel_alias || '').trim() || null;
  if (!row) return emptySecondaryPayload(alias, generatedAt);

  const checkedAt = num(row.checked_at);
  const changedAt = num(row.changed_at);
  const startTime = num(row.start_time);
  const stationId = num(row.station_id);
  const queueId = num(row.queue_id);
  const parsed = parseQueueJson(row.queue_json);
  const queueCorrupt = parsed === null;
  const source = parsed || [];
  const rows = source.map((track, index) => ({
    ...track,
    observed_at: checkedAt,
    station_id: stationId,
    queue_id: queueId,
    start_time: startTime,
    position: num(track?.position) ?? index,
  }));
  const paused = storedBoolean(row.is_paused);
  const broadcasting = storedBoolean(row.is_broadcasting);
  const playbackAt = paused
    ? changedAt ?? checkedAt ?? generatedAt
    : generatedAt;
  const computed = computePlayback(rows, playbackAt);
  const ended = !paused
    && computed.queueEndAt != null
    && playbackAt >= computed.queueEndAt
    && rows.length > 0;
  const playback = ended
    ? { ...computed, currentIndex: -1, progressMs: 0, anchorAt: null }
    : computed;
  const stale = queueCorrupt || checkedAt == null || generatedAt - checkedAt > SECONDARY_STALE_MS;
  const visiblePlayback = stale
    ? { ...playback, currentIndex: -1, progressMs: 0, anchorAt: null }
    : playback;
  const queue = rows.map((track, index) => normalizePlaybackTrack(track, index, visiblePlayback));
  const playing = !stale && broadcasting && !paused && !ended && visiblePlayback.currentIndex >= 0;

  return {
    ok: true,
    channel_alias: alias,
    generated_at: generatedAt,
    latest_observed_at: checkedAt,
    queue_observed_at: checkedAt,
    changed_at: changedAt,
    station_id: stationId,
    is_broadcasting: broadcasting,
    host_account_id: num(row.host_account_id),
    host_handle: row.host_handle || null,
    playing,
    stale,
    queue_corrupt: queueCorrupt,
    setup_required: false,
    queue_revision: row.state_hash || null,
    queue_status: {
      queue_id: queueId,
      start_time: startTime,
      is_paused: paused,
      playing,
      ended,
      current_index: visiblePlayback.currentIndex,
      progress_ms: visiblePlayback.progressMs,
      anchor_at: visiblePlayback.anchorAt,
      queue_end_at: visiblePlayback.queueEndAt,
      total_items: queue.length,
    },
    queue,
  };
}

async function secondaryPlaybackResponse(db, alias, generatedAt) {
  const collector = await loadBuddyCollectorStatus(db, alias);
  try {
    const row = await db.prepare(SECONDARY_PLAYBACK_SQL).bind(alias).first();
    const payload = row
      ? secondaryPlaybackPayload(row, generatedAt)
      : emptySecondaryPayload(alias, generatedAt);
    return json(
      attachBuddyCollectorStatus(payload, collector),
      200,
      CACHE_CONTROL,
    );
  } catch (error) {
    if (missingPlaybackTable(error)) {
      return json(
        attachBuddyCollectorStatus(
          emptySecondaryPayload(alias, generatedAt, true),
          collector,
        ),
        200,
        CACHE_CONTROL,
      );
    }
    throw error;
  }
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return json({ ok: false, error: 'DB binding missing' }, 500, 'no-store');

  try {
    const generatedAt = Date.now();
    const channelAlias = requestedChannel(request);
    if (channelAlias !== DEFAULT_CHANNEL_ALIAS) {
      return await secondaryPlaybackResponse(db, channelAlias, generatedAt);
    }

    const result = await db.prepare(PLAYBACK_FEED_SQL).all();
    const { latest, latestQueue, queue: rows } = parsePlaybackFeedRows(result.results || []);
    const revision = queueRevision(stateFromQueue(latestQueue, rows), hostIdentity(latest));

    if (!latestQueue) {
      return json({
        ok: true,
        channel_alias: DEFAULT_CHANNEL_ALIAS,
        generated_at: generatedAt,
        latest_observed_at: num(latest?.observed_at),
        station_id: num(latest?.station_id),
        is_broadcasting: storedBoolean(latest?.is_broadcasting),
        host_handle: latest?.host_handle || null,
        queue_revision: revision,
        queue_status: null,
        queue: [],
      }, 200, CACHE_CONTROL);
    }

    const playback = computePlayback(rows, generatedAt);
    const queue = rows.map((track, index) => normalizePlaybackTrack(track, index, playback));
    const paused = storedBoolean(latestQueue.is_paused);
    const broadcasting = storedBoolean(latest?.is_broadcasting);
    const playing = broadcasting && !paused && playback.currentIndex >= 0;

    return json({
      ok: true,
      channel_alias: DEFAULT_CHANNEL_ALIAS,
      generated_at: generatedAt,
      latest_observed_at: num(latest?.observed_at),
      queue_observed_at: num(latestQueue.observed_at),
      station_id: num(latestQueue.station_id),
      is_broadcasting: broadcasting,
      host_account_id: num(latest?.host_account_id),
      host_handle: latest?.host_handle || null,
      broadcast_start_time: num(latest?.broadcast_start_time),
      playing,
      queue_revision: revision,
      queue_status: {
        queue_id: num(latestQueue.queue_id),
        start_time: num(latestQueue.start_time),
        is_paused: paused,
        playing,
        current_index: playback.currentIndex,
        progress_ms: playback.progressMs,
        anchor_at: playback.anchorAt,
        queue_end_at: playback.queueEndAt,
        total_items: queue.length,
      },
      queue,
    }, 200, CACHE_CONTROL);
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error?.message || 'playback feed error' }, 500, 'no-store');
  }
}
