import { firstDefined } from './collector-config.js';

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
    raw: channel,
  };
}

// The minute-fact job pipeline (worker/src/minute-facts-*.js) never reads
// `raw` - it embeds the full upstream API response and, for queue tracks,
// duplicates it a second time (queue.raw plus per-track raw). Stripping it
// before the payload is JSON.stringify'd into sh_minute_fact_jobs avoids
// serializing/deserializing several times more data than the job needs.
export function minuteFactSnapshot(snapshot) {
  if (!snapshot) return snapshot;
  const { raw, ...rest } = snapshot;
  return rest;
}

function boundedText(value, maximum = 500) {
  const parsed = String(value ?? '').trim();
  return parsed ? parsed.slice(0, maximum) : null;
}

export function readModelPresentation(snapshot) {
  const raw = snapshot?.raw || {};
  const station = raw?.current_station || {};
  const owner = station?.owner || raw?.owner || raw?.account || raw?.creator || {};
  const images = raw?.images || {};
  return {
    ...minuteFactSnapshot(snapshot),
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
}

export function minuteFactQueue(queue) {
  if (!queue) return queue;
  const { raw, tracks, ...rest } = queue;
  return {
    ...rest,
    tracks: (tracks || []).map(({ raw: trackRaw, ...track }) => {
      const source = trackRaw?.track || trackRaw || {};
      const artist = source?.artist || source?.artists?.[0] || {};
      const album = source?.album || {};
      return {
        ...track,
        title: boundedText(source?.title ?? source?.name, 500),
        artist: boundedText(
          typeof artist === 'string' ? artist : (artist?.name ?? source?.artist_name),
          500,
        ),
        album_name: boundedText(album?.name ?? source?.album_name, 500),
        thumbnail_url: boundedText(
          source?.image_url ?? source?.artwork_url ?? source?.album_art_url
            ?? album?.image_url ?? album?.artwork_url,
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
  const queueTracks = queue?.queue_tracks || queue?.tracks || [];
  return {
    station_id: firstDefined(queue?.station_id, station?.id, stationId),
    queue_id: queue?.id ?? null,
    start_time: queue?.start_time ?? null,
    is_paused: queue?.is_paused ?? null,
    tracks: queueTracks.map((item, position) => {
      const track = item?.track || item;
      return {
        position,
        queue_track_id: item?.id ?? null,
        stationhead_track_id: track?.id ?? null,
        spotify_id: track?.spotify_id ?? null,
        apple_music_id: track?.apple_music_id ?? null,
        deezer_id: track?.deezer_id ?? null,
        isrc: track?.isrc ?? null,
        duration_ms: track?.duration ?? null,
        preview_url: track?.preview ?? null,
        bite_count: track?.bite_count ?? null,
        raw: item,
      };
    }),
    raw: queue,
  };
}
