const DEFAULT_ALIAS = 'buddy46';
const DEFAULT_MAX_TRACKS = 80;

function finiteNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return Boolean(value);
}

function text(value, maximum = 500) {
  const parsed = String(value ?? '').trim();
  return parsed ? parsed.slice(0, maximum) : null;
}

function handleMatches(value, expectedAlias) {
  return String(value || '').trim().toLowerCase() === String(expectedAlias || '').trim().toLowerCase();
}

function channelMatchesExpectedHandle(channel, expectedAlias) {
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)) return false;
  if (handleMatches(channel.account?.handle, expectedAlias)) return true;
  if (handleMatches(channel.host?.handle, expectedAlias)) return true;
  if (handleMatches(channel.host?.account?.handle, expectedAlias)) return true;
  const broadcasters = [
    ...(Array.isArray(channel.broadcast?.broadcasters) ? channel.broadcast.broadcasters : []),
    ...(Array.isArray(channel.current_station?.broadcast?.broadcasters)
      ? channel.current_station.broadcast.broadcasters : []),
  ];
  return broadcasters.some((item) => handleMatches(
    item?.account?.handle || item?.handle,
    expectedAlias,
  ));
}

export function validateBuddyChannelPayload(channel, expectedAlias = DEFAULT_ALIAS) {
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
    throw new Error('Stationhead buddy playback response is not an object');
  }
  const expected = String(expectedAlias).trim().toLowerCase();
  const actualAlias = String(channel.alias || channel.channel_alias || '').trim().toLowerCase();
  if (!actualAlias) throw new Error('Stationhead buddy playback response is missing channel alias');
  if (actualAlias !== expected && !channelMatchesExpectedHandle(channel, expected)) {
    throw new Error(`Stationhead alias mismatch: expected ${expectedAlias}, received ${actualAlias}`);
  }
  const queue = channel?.current_station?.queue || channel?.queue || null;
  const stationId = queue?.station_id
    ?? channel?.current_station?.id
    ?? channel?.current_station_id
    ?? channel?.id
    ?? channel?.broadcast?.station_id;
  if (stationId == null && !queue) {
    throw new Error('Stationhead buddy playback response is missing station fields');
  }
  return channel;
}

function trackThumbnail(item, track) {
  const candidates = [
    track?.thumbnail_url,
    track?.image_url,
    track?.album_art_url,
    track?.artwork_url,
    track?.album?.thumbnail_url,
    track?.album?.image_url,
    track?.album?.artwork_url,
    track?.album?.images?.[0]?.url,
    item?.thumbnail_url,
    item?.image_url,
    item?.album_art_url,
    item?.artwork_url,
  ];
  return text(candidates.find((value) => String(value || '').trim()), 2_048);
}

export function extractBuddyPlayback(channel, alias = DEFAULT_ALIAS, maxTracks = DEFAULT_MAX_TRACKS) {
  const station = channel?.current_station || {};
  const queue = station?.queue || channel?.queue || null;
  const broadcast = station?.broadcast || channel?.broadcast || null;
  const host = broadcast?.broadcasters?.find((item) => item?.is_host)
    || broadcast?.broadcasters?.[0]
    || null;
  const rawTracks = queue?.queue_tracks ?? queue?.tracks ?? [];
  if (!Array.isArray(rawTracks)) {
    throw new Error('Stationhead buddy playback queue tracks are not an array');
  }
  const tracks = rawTracks.slice(0, maxTracks).map((item, index) => {
    const track = item?.track || item || {};
    const artist = track?.artist || track?.artists?.[0] || {};
    const album = track?.album || {};
    return {
      position: finiteNumber(item?.position, index),
      queue_track_id: finiteNumber(item?.id),
      stationhead_track_id: finiteNumber(track?.id),
      spotify_id: text(track?.spotify_id),
      deezer_id: text(track?.deezer_id),
      isrc: text(track?.isrc),
      duration_ms: Math.max(0, finiteNumber(track?.duration_ms ?? track?.duration, 0)),
      preview_url: text(track?.preview_url ?? track?.preview, 2_048),
      title: text(track?.title ?? track?.name),
      artist: text(
        typeof artist === 'string' ? artist : (artist?.name ?? track?.artist_name),
      ),
      album_name: text(album?.name ?? track?.album_name),
      thumbnail_url: trackThumbnail(item, track),
    };
  });
  return {
    channel_alias: alias,
    station_id: finiteNumber(queue?.station_id ?? station?.id ?? channel?.current_station_id ?? channel?.id ?? broadcast?.station_id),
    queue_id: finiteNumber(queue?.id),
    start_time: finiteNumber(queue?.start_time),
    is_paused: booleanValue(queue?.is_paused),
    is_broadcasting: booleanValue(station?.is_broadcasting ?? channel?.is_broadcasting),
    host_account_id: finiteNumber(host?.account_id ?? host?.account?.id),
    host_handle: text(host?.account?.handle),
    tracks,
  };
}

export function currentIndex(queue, now) {
  if (!queue.tracks.length) return -1;
  if (!queue.start_time) return 0;
  const elapsed = Math.max(0, now - queue.start_time);
  let cursor = 0;
  for (let index = 0; index < queue.tracks.length; index += 1) {
    const duration = Math.max(0, finiteNumber(queue.tracks[index]?.duration_ms, 0));
    if (elapsed < cursor + duration || index === queue.tracks.length - 1) return index;
    cursor += duration;
  }
  return queue.tracks.length - 1;
}
