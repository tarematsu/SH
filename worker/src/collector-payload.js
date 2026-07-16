import { firstDefined } from './collector-config.js';

const COMPACT_QUEUE_MARKER = Symbol('compact-queue');
const QUEUE_STRUCTURAL_PAYLOAD = Symbol.for('stationhead.queue.structural-payload');
const QUEUE_LIKE_ANALYSIS = Symbol.for('stationhead.queue.like-analysis');

export function validateChannelPayload(channel, expectedAlias) {
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
    throw new Error('Stationhead channel response shape changed: root payload is not an object');
  }
  const channelId = firstDefined(channel.id, channel.channel_id);
  const channelAlias = String(channel.alias || channel.channel_alias || '').trim();
  if (channelId === undefined || channelId === null) {
    throw new Error('Stationhead channel response shape changed: channel id is missing');
  }
  if (!channelAlias) {
    throw new Error('Stationhead channel response shape changed: channel alias is missing');
  }
  if (expectedAlias && channelAlias.toLowerCase() !== String(expectedAlias).trim().toLowerCase()) {
    throw new Error(`Stationhead channel response shape changed: expected alias=${expectedAlias}, received alias=${channelAlias}`);
  }
  if (!('current_station' in channel) && !('current_station_id' in channel)) {
    throw new Error('Stationhead channel response shape changed: current_station fields are missing');
  }
  return channel;
}

export function extractIds(channel, state) {
  const station = channel?.current_station || null;
  state.channelId = firstDefined(channel?.id, state.channelId);
  state.stationId = firstDefined(channel?.current_station_id, station?.id, state.stationId);
}

export function normalizeSnapshot(channel, state, config) {
  const station = channel?.current_station || {};
  const party = station?.streaming_party || channel?.streaming_party || {};
  const host = station?.broadcast?.broadcasters?.find((item) => item?.is_host)
    || station?.broadcast?.broadcasters?.[0]
    || null;
  const owner = station?.owner || channel?.owner || channel?.account || channel?.creator || {};
  const images = channel?.images || {};
  return {
    channel_id: firstDefined(channel?.id, state.channelId),
    channel_alias: channel?.alias || config.channelAlias,
    channel_name: channel?.channel_name ?? null,
    station_id: firstDefined(channel?.current_station_id, station?.id, state.stationId),
    is_launched: station?.is_launched ?? null,
    is_broadcasting: station?.is_broadcasting ?? null,
    chat_status: station?.chat_status ?? null,
    listener_count: firstDefined(station?.listener_count, channel?.listener_count),
    online_member_count: channel?.online_member_count ?? null,
    total_member_count: channel?.total_member_count ?? null,
    guest_count: firstDefined(station?.guest_count, channel?.guest_count),
    total_listens: station?.total_listens ?? null,
    stream_goal: party?.stream_goal ?? null,
    current_stream_count: party?.current_stream_count ?? null,
    host_account_id: firstDefined(host?.account_id, host?.account?.id),
    host_handle: host?.account?.handle ?? null,
    broadcast_start_time: station?.broadcast?.start_time ?? null,
    presentation: {
      description: boundedText(channel?.description ?? channel?.channel_description, 2_000),
      artist_name: boundedText(channel?.artist_name, 500),
      accent_color: boundedText(channel?.accent_color, 100),
      images: {
        medium: {
          url: boundedText(
            images?.medium?.url ?? channel?.image_url ?? channel?.channel_image_url ?? channel?.avatar_url,
            2_048,
          ),
        },
        logo: { medium: { url: boundedText(images?.logo?.medium?.url, 2_048) } },
      },
      current_station: {
        status: boundedText(station?.status, 2_000),
        streaming_party: {
          stream_goal: party?.stream_goal ?? null,
          current_stream_count: party?.current_stream_count ?? null,
        },
        owner: {
          thumbnail: { url: boundedText(owner?.thumbnail?.url, 2_048) },
          medium: { url: boundedText(owner?.medium?.url, 2_048) },
        },
      },
    },
  };
}

// The minute-fact job pipeline (worker/src/minute-facts-*.js) never reads
// the full upstream `raw` or the read-model-only `presentation`. Stripping
// them before the payload is JSON.stringify'd into sh_minute_fact_jobs keeps
// the durable handoff focused on fact fields.
export function minuteFactSnapshot(snapshot) {
  if (!snapshot) return snapshot;
  const { raw, presentation, ...rest } = snapshot;
  return rest;
}

function boundedText(value, maximum = 500) {
  const parsed = String(value ?? '').trim();
  return parsed ? parsed.slice(0, maximum) : null;
}

function normalizedNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedText(value) {
  return value === undefined || value === null ? null : String(value);
}

function normalizedBoolean(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return 1;
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return 0;
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value === 0 ? 0 : 1;
  }
  return null;
}

function likeTrackKey(isrcValue, spotifyIdValue) {
  const isrc = normalizedText(isrcValue)?.trim().toUpperCase();
  if (isrc) return `isrc:${isrc}`;
  const spotifyId = normalizedText(spotifyIdValue)?.trim();
  return spotifyId ? `spotify:${spotifyId}` : null;
}

export function readModelPresentation(snapshot) {
  if (snapshot?.presentation && typeof snapshot.presentation === 'object' && !Array.isArray(snapshot.presentation)) {
    return snapshot.presentation;
  }
  const raw = snapshot?.raw || {};
  const station = raw?.current_station || {};
  const owner = station?.owner || raw?.owner || raw?.account || raw?.creator || {};
  const images = raw?.images || {};
  const presentation = snapshot?.presentation || {
    description: boundedText(raw?.description ?? raw?.channel_description, 2_000),
    artist_name: boundedText(raw?.artist_name, 500),
    accent_color: boundedText(raw?.accent_color, 100),
    images: {
      medium: { url: boundedText(images?.medium?.url ?? raw?.image_url ?? raw?.channel_image_url ?? raw?.avatar_url, 2_048) },
      logo: { medium: { url: boundedText(images?.logo?.medium?.url, 2_048) } },
    },
    current_station: {
      status: boundedText(station?.status, 2_000),
      streaming_party: {
        stream_goal: station?.streaming_party?.stream_goal ?? snapshot?.stream_goal ?? null,
        current_stream_count: station?.streaming_party?.current_stream_count ?? snapshot?.current_stream_count ?? null,
      },
      owner: {
        thumbnail: { url: boundedText(owner?.thumbnail?.url, 2_048) },
        medium: { url: boundedText(owner?.medium?.url, 2_048) },
      },
    },
  };
  return presentation;
}

export function minuteFactQueue(queue) {
  if (!queue) return queue;
  if (queue[COMPACT_QUEUE_MARKER]) return queue;
  const { raw, tracks, ...rest } = queue;
  const compactTracks = Array.isArray(tracks) ? tracks : [];
  const alreadyCompact = !raw && compactTracks.every((track) => (
    track && Object.prototype.hasOwnProperty.call(track, 'title')
      && Object.prototype.hasOwnProperty.call(track, 'artist')
      && Object.prototype.hasOwnProperty.call(track, 'album_name')
      && Object.prototype.hasOwnProperty.call(track, 'thumbnail_url')
  ));
  if (alreadyCompact) return queue;
  return {
    ...rest,
    tracks: compactTracks.map(({ raw: trackRaw, ...track }) => {
      const source = trackRaw?.track || trackRaw || {};
      const artist = source?.artist || source?.artists?.[0] || {};
      const album = source?.album || {};
      return {
        ...track,
        title: boundedText(track?.title ?? source?.title ?? source?.name, 500),
        artist: boundedText(
          track?.artist ?? (typeof artist === 'string' ? artist : (artist?.name ?? source?.artist_name)),
          500,
        ),
        album_name: boundedText(track?.album_name ?? album?.name ?? source?.album_name, 500),
        thumbnail_url: boundedText(
          track?.thumbnail_url ?? source?.thumbnail_url ?? source?.image_url
            ?? source?.artwork_url ?? source?.album_art_url
            ?? album?.thumbnail_url ?? album?.image_url ?? album?.artwork_url
            ?? album?.images?.[0]?.url,
          2_048,
        ),
      };
    }),
  };
}

export function attachMinuteFactQueueMetadata(queue, rows = []) {
  if (!queue?.tracks?.length || !rows?.length) return queue;
  const metadata = new Map(rows.map((row) => [String(row.spotify_id || ''), row]));
  return {
    ...queue,
    tracks: queue.tracks.map((track) => {
      const row = track.spotify_id ? metadata.get(String(track.spotify_id)) : null;
      if (!row) return track;
      return {
        ...track,
        title: track.title || boundedText(row.title, 500),
        artist: track.artist || boundedText(row.artist, 500),
        album_name: track.album_name || boundedText(row.album_name, 500),
        thumbnail_url: track.thumbnail_url || boundedText(row.thumbnail_url, 2_048),
      };
    }),
  };
}

export function extractQueue(channel, stationId) {
  const station = channel?.current_station || {};
  const queue = station?.queue || channel?.queue || null;
  if (!queue) return null;
  const queueTracks = Array.isArray(queue?.queue_tracks)
    ? queue.queue_tracks
    : Array.isArray(queue?.tracks)
      ? queue.tracks
      : [];
  const compactTracks = new Array(queueTracks.length);
  const structuralTracks = new Array(queueTracks.length);
  const likeValues = new Map();
  let identifiableLikes = 0;
  let completeLikes = true;

  for (let position = 0; position < queueTracks.length; position += 1) {
    const item = queueTracks[position];
    const track = item?.track || item;
    const artist = track?.artist || track?.artists?.[0] || {};
    const album = track?.album || {};
    const queueTrackId = item?.id ?? null;
    const stationheadTrackId = track?.id ?? null;
    const spotifyId = track?.spotify_id ?? null;
    const deezerId = track?.deezer_id ?? null;
    const isrc = track?.isrc ?? null;
    const durationMs = track?.duration ?? null;
    const previewUrl = track?.preview ?? null;
    const biteCount = track?.bite_count ?? null;

    structuralTracks[position] = {
      position,
      queue_track_id: normalizedNumber(queueTrackId),
      stationhead_track_id: normalizedNumber(stationheadTrackId),
      spotify_id: normalizedText(spotifyId),
      deezer_id: normalizedText(deezerId),
      isrc: normalizedText(isrc),
      duration_ms: normalizedNumber(durationMs),
      preview_url: normalizedText(previewUrl),
    };

    const trackKey = likeTrackKey(isrc, spotifyId);
    if (trackKey) {
      identifiableLikes += 1;
      const likeCount = normalizedNumber(biteCount);
      if (likeCount == null) completeLikes = false;
      else likeValues.set(trackKey, likeCount);
    }

    compactTracks[position] = {
      position,
      queue_track_id: queueTrackId,
      stationhead_track_id: stationheadTrackId,
      spotify_id: spotifyId,
      deezer_id: deezerId,
      isrc,
      duration_ms: durationMs,
      preview_url: previewUrl,
      bite_count: biteCount,
      title: boundedText(track?.title ?? track?.name, 500),
      artist: boundedText(
        typeof artist === 'string' ? artist : (artist?.name ?? track?.artist_name),
        500,
      ),
      album_name: boundedText(album?.name ?? track?.album_name, 500),
      thumbnail_url: boundedText(
        track?.thumbnail_url ?? track?.image_url ?? track?.artwork_url ?? track?.album_art_url
          ?? album?.thumbnail_url ?? album?.image_url ?? album?.artwork_url
          ?? album?.images?.[0]?.url
          ?? item?.thumbnail_url ?? item?.image_url ?? item?.artwork_url ?? item?.album_art_url,
        2_048,
      ),
    };
  }

  const likePayload = new Array(likeValues.size);
  let likeIndex = 0;
  for (const [trackKey, likeCount] of likeValues) {
    likePayload[likeIndex] = { track_key: trackKey, like_count: likeCount };
    likeIndex += 1;
  }
  likePayload.sort((left, right) => left.track_key.localeCompare(right.track_key));

  const compactQueue = {
    station_id: firstDefined(queue?.station_id, station?.id, stationId),
    queue_id: queue?.id ?? null,
    start_time: queue?.start_time ?? null,
    is_paused: queue?.is_paused ?? null,
    tracks: compactTracks,
  };
  const likeAnalysis = {
    complete: identifiableLikes === 0 || completeLikes,
    payload: likePayload,
  };
  const structuralPayload = {
    station_id: normalizedNumber(compactQueue.station_id),
    queue_id: normalizedNumber(compactQueue.queue_id),
    start_time: normalizedNumber(compactQueue.start_time),
    is_paused: normalizedBoolean(compactQueue.is_paused),
    tracks: structuralTracks,
  };
  Object.defineProperties(compactQueue, {
    [COMPACT_QUEUE_MARKER]: { value: true },
    [QUEUE_STRUCTURAL_PAYLOAD]: { value: structuralPayload },
  });
  Object.defineProperty(compactQueue.tracks, QUEUE_LIKE_ANALYSIS, { value: likeAnalysis });
  return compactQueue;
}
