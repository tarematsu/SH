import { json, stripPlaybackPublicFields } from '../lib/api-utils.js';
import {
  attachBuddyCollectorStatus,
  loadBuddyCollectorStatus,
} from '../lib/buddy-collector-status.js';
import { computePlayback } from '../lib/playback.js';
import { loadPrimaryPlaybackPayload } from '../lib/primary-playback.js';
import {
  emptySecondaryPayload,
  loadSecondaryPlaybackMetadata,
  SECONDARY_PLAYBACK_SQL,
  secondaryPlaybackPayload,
} from '../lib/secondary-playback.js';

const CACHE_CONTROL = 'public, max-age=5, s-maxage=10, stale-while-revalidate=30';
const DEFAULT_CHANNEL_ALIAS = 'buddies';
const SECONDARY_PLAYBACK_LEGACY_SQL = `SELECT channel_alias,station_id,queue_id,start_time,
  is_paused,is_broadcasting,host_account_id,host_handle,state_hash,queue_json,
  checked_at,changed_at
FROM sh_playback_channel_current WHERE channel_alias=? LIMIT 1`;
const PLAYBACK_SUCCESS_DEFAULTS = Object.freeze({
  channel_alias: null,
  generated_at: null,
  latest_observed_at: null,
  queue_observed_at: null,
  changed_at: null,
  station_id: null,
  is_broadcasting: false,
  host_account_id: null,
  host_handle: null,
  playing: false,
  stale: true,
  setup_required: false,
  queue_revision: null,
  queue_status: null,
  queue: [],
});
const PLAYBACK_CORS_HEADERS = Object.freeze({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'Accept',
  'access-control-max-age': '86400',
});

export {
  computePlayback,
  SECONDARY_PLAYBACK_SQL,
  secondaryPlaybackPayload,
};

function stabilizePlaybackSuccess(data) {
  if (!data || data.ok !== true) return data;
  const queue = Array.isArray(data.queue)
    ? data.queue.map((track) => {
        if (!track || track.is_current !== false) return track;
        const { is_current: _isCurrent, ...rest } = track;
        return rest;
      })
    : [];
  return {
    ok: true,
    ...PLAYBACK_SUCCESS_DEFAULTS,
    ...data,
    queue_status: data.queue_status ?? null,
    queue,
  };
}

function playbackJson(data, status = 200, cache = null) {
  const { raw_payload_passthrough: _rawPayloadPassthrough, ...payload } = data || {};
  return json(
    stripPlaybackPublicFields(stabilizePlaybackSuccess(payload)),
    status,
    cache,
    PLAYBACK_CORS_HEADERS,
  );
}

function requestedChannel(request) {
  if (!request?.url) return DEFAULT_CHANNEL_ALIAS;
  const value = new URL(request.url).searchParams.get('channel');
  return String(value || DEFAULT_CHANNEL_ALIAS).trim().toLowerCase() || DEFAULT_CHANNEL_ALIAS;
}

function requestedRawPayload(request) {
  if (!request?.url) return false;
  const value = new URL(request.url).searchParams.get('raw');
  return ['1', 'true', 'yes'].includes(String(value || '').trim().toLowerCase());
}

function missingPlaybackTable(error) {
  return /no such table:\s*sh_playback_channel_current/i.test(String(error?.message || error));
}

function missingPlaybackClockTable(error) {
  return /no such table:\s*sh_buddy_playback_clock/i.test(String(error?.message || error));
}

function text(value) {
  const parsed = String(value ?? '').trim();
  return parsed && parsed !== '[object Object]' ? parsed : null;
}

function rawQueue(payload) {
  return payload?.current_station?.queue || payload?.queue || null;
}

function storedQueueTracks(row) {
  if (!row?.queue_json) return [];
  let parsed;
  try {
    parsed = JSON.parse(row.queue_json);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  const queue = rawQueue(parsed);
  if (Array.isArray(queue?.queue_tracks)) return queue.queue_tracks;
  if (Array.isArray(queue?.tracks)) return queue.tracks;
  return [];
}

function trackArtist(track) {
  const artist = track?.artist || track?.artists?.[0] || null;
  return text(typeof artist === 'string' ? artist : artist?.name) || text(track?.artist_name);
}

function trackThumbnail(item, track) {
  return text(
    track?.thumbnail_url
      ?? track?.image_url
      ?? track?.album_art_url
      ?? track?.artwork_url
      ?? track?.album?.thumbnail_url
      ?? track?.album?.image_url
      ?? track?.album?.artwork_url
      ?? track?.album?.images?.[0]?.url
      ?? item?.thumbnail_url
      ?? item?.image_url
      ?? item?.album_art_url
      ?? item?.artwork_url,
  );
}

export function secondaryRowNeedsMetadata(row) {
  return storedQueueTracks(row).some((item) => {
    const track = item?.track || item || {};
    const lookupAvailable = Boolean(text(track?.spotify_id ?? item?.spotify_id) || text(track?.isrc ?? item?.isrc));
    if (!lookupAvailable) return false;
    return !text(track?.title ?? track?.name) || !trackArtist(track) || !trackThumbnail(item, track);
  });
}

async function loadSecondaryPlaybackRow(otherDb, alias) {
  try {
    return await otherDb.prepare(SECONDARY_PLAYBACK_SQL).bind(alias).first();
  } catch (error) {
    if (!missingPlaybackClockTable(error)) throw error;
    return otherDb.prepare(SECONDARY_PLAYBACK_LEGACY_SQL).bind(alias).first();
  }
}

async function secondaryPlaybackResponse(otherDb, alias, generatedAt, includeRawPayload) {
  const collectorPromise = loadBuddyCollectorStatus(otherDb, alias);
  try {
    const [collector, row] = await Promise.all([
      collectorPromise,
      loadSecondaryPlaybackRow(otherDb, alias),
    ]);
    const metadata = row && secondaryRowNeedsMetadata(row)
      ? await loadSecondaryPlaybackMetadata(otherDb, row)
      : new Map();
    const payload = row
      ? secondaryPlaybackPayload(row, generatedAt, {
          includeRawPayload,
          metadata,
        })
      : emptySecondaryPayload(alias, generatedAt);
    return playbackJson(
      attachBuddyCollectorStatus(payload, collector),
      200,
      CACHE_CONTROL,
    );
  } catch (error) {
    if (!missingPlaybackTable(error)) throw error;
    const collector = await collectorPromise;
    return playbackJson(
      attachBuddyCollectorStatus(
        emptySecondaryPayload(alias, generatedAt, true),
        collector,
      ),
      200,
      CACHE_CONTROL,
    );
  }
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: PLAYBACK_CORS_HEADERS,
  });
}

export async function onRequestGet({ request, env }) {
  try {
    const generatedAt = Date.now();
    const channelAlias = requestedChannel(request);
    if (channelAlias !== DEFAULT_CHANNEL_ALIAS) {
      if (!env.OTHER_DB) {
        return playbackJson({ ok: false, error: 'OTHER_DB binding missing' }, 500, 'no-store');
      }
      return secondaryPlaybackResponse(
        env.OTHER_DB,
        channelAlias,
        generatedAt,
        requestedRawPayload(request),
      );
    }

    if (!env.MINUTE_DB) {
      return playbackJson({ ok: false, error: 'MINUTE_DB binding missing' }, 500, 'no-store');
    }
    const payload = await loadPrimaryPlaybackPayload(env.MINUTE_DB, generatedAt);
    return playbackJson(payload, 200, CACHE_CONTROL);
  } catch (error) {
    console.error(error);
    return playbackJson({ ok: false, error: error?.message || 'playback feed error' }, 500, 'no-store');
  }
}
