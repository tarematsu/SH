export function firstDefined(...values) {
  return values.find((v) => v !== undefined && v !== null);
}

export function extractIds(channel, runtime) {
  const station = channel?.current_station || null;
  const party = station?.streaming_party || channel?.streaming_party || null;
  runtime.channelId = firstDefined(channel?.id, runtime.channelId);
  runtime.stationId = firstDefined(channel?.current_station_id, station?.id, runtime.stationId);
  runtime.streamingPartyId = firstDefined(party?.id, channel?.streaming_party_id, runtime.streamingPartyId);
}

export function normalizeSnapshot(channel, runtime, config) {
  const station = channel?.current_station || {};
  const party = station?.streaming_party || channel?.streaming_party || {};
  const host = station?.broadcast?.broadcasters?.find((b) => b?.is_host) || station?.broadcast?.broadcasters?.[0] || null;
  return {
    channel_id: firstDefined(channel?.id, runtime.channelId),
    channel_alias: channel?.alias || config.channelAlias,
    channel_name: channel?.channel_name ?? null,
    station_id: firstDefined(channel?.current_station_id, station?.id, runtime.stationId),
    is_launched: station?.is_launched ?? null,
    is_broadcasting: station?.is_broadcasting ?? null,
    chat_status: station?.chat_status ?? null,
    listener_count: firstDefined(station?.listener_count, channel?.listener_count),
    online_member_count: channel?.online_member_count ?? null,
    total_member_count: channel?.total_member_count ?? null,
    guest_count: firstDefined(station?.guest_count, channel?.guest_count),
    total_listens: station?.total_listens ?? null,
    stream_goal: party?.stream_goal ?? null,
    current_stream_count: firstDefined(party?.current_stream_count, party?.current_stream_),
    host_account_id: firstDefined(host?.account_id, host?.account?.id),
    host_handle: host?.account?.handle ?? null,
    broadcast_start_time: station?.broadcast?.start_time ?? null,
    raw: channel,
  };
}

export { normalizeComments } from 'sh-shared';

export function extractQueue(channel, runtime) {
  const station = channel?.current_station || {};
  const queue = station?.queue || channel?.queue || null;
  if (!queue) return null;
  const queueTracks = queue?.queue_tracks || queue?.tracks || [];
  return {
    station_id: firstDefined(queue?.station_id, station?.id, runtime.stationId),
    queue_id: queue?.id ?? null,
    start_time: queue?.start_time ?? null,
    is_paused: queue?.is_paused ?? null,
    tracks: queueTracks.map((item, index) => {
      const track = item?.track || item;
      return {
        position: index,
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
