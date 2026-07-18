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
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  return Boolean(value);
}

function text(value, maximum = 500) {
  const parsed = String(value ?? '').trim();
  return parsed ? parsed.slice(0, maximum) : null;
}

function handleMatches(value, expectedAlias) {
  return String(value || '').trim().toLowerCase() === String(expectedAlias || '').trim().toLowerCase();
}

function broadcastersMatch(items, expectedAlias) {
  if (!Array.isArray(items)) return false;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (handleMatches(item?.account?.handle || item?.handle, expectedAlias)) return true;
  }
  return false;
}

function channelMatchesExpectedHandle(channel, expectedAlias) {
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)) return false;
  if (handleMatches(channel.account?.handle, expectedAlias)) return true;
  if (handleMatches(channel.host?.handle, expectedAlias)) return true;
  if (handleMatches(channel.host?.account?.handle, expectedAlias)) return true;
  return broadcastersMatch(channel.broadcast?.broadcasters, expectedAlias)
    || broadcastersMatch(channel.current_station?.broadcast?.broadcasters, expectedAlias);
}

function channelAliasMatchesHandleStation(actualAlias, expectedAlias) {
  return String(expectedAlias || '').trim().toLowerCase() === 'buddy46'
    && String(actualAlias || '').trim().toLowerCase() === 'buddies';
}

export function validateBuddyChannelPayload(channel, expectedAlias = DEFAULT_ALIAS) {
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
    throw new Error('Stationhead buddy playback response is not an object');
  }
  const expected = String(expectedAlias).trim().toLowerCase();
  const actualAlias = String(channel.alias || channel.channel_alias || '').trim().toLowerCase();
  if (!actualAlias) throw new Error('Stationhead buddy playback response is missing channel alias');
  if (actualAlias !== expected
      && !channelAliasMatchesHandleStation(actualAlias, expected)
      && !channelMatchesExpectedHandle(channel, expected)) {
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

function firstPresent(...values) {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function trackThumbnail(item, track) {
  let value = track?.thumbnail_url;
  if (value === undefined || value === null || value === '') value = track?.image_url;
  if (value === undefined || value === null || value === '') value = track?.album_art_url;
  if (value === undefined || value === null || value === '') value = track?.artwork_url;
  if (value === undefined || value === null || value === '') value = track?.album?.thumbnail_url;
  if (value === undefined || value === null || value === '') value = track?.album?.image_url;
  if (value === undefined || value === null || value === '') value = track?.album?.artwork_url;
  if (value === undefined || value === null || value === '') value = track?.album?.images?.[0]?.url;
  if (value === undefined || value === null || value === '') value = item?.thumbnail_url;
  if (value === undefined || value === null || value === '') value = item?.image_url;
  if (value === undefined || value === null || value === '') value = item?.album_art_url;
  if (value === undefined || value === null || value === '') value = item?.artwork_url;
  return text(value, 2_048);
}

function hostBroadcaster(broadcast) {
  const broadcasters = broadcast?.broadcasters;
  if (!Array.isArray(broadcasters) || !broadcasters.length) return null;
  for (let index = 0; index < broadcasters.length; index += 1) {
    if (broadcasters[index]?.is_host) return broadcasters[index];
  }
  return broadcasters[0];
}

export function extractBuddyPlayback(channel, alias = DEFAULT_ALIAS, maxTracks = DEFAULT_MAX_TRACKS) {
  const station = channel?.current_station || {};
  const queue = station?.queue || channel?.queue || null;
  const broadcast = station?.broadcast || channel?.broadcast || null;
  const host = hostBroadcaster(broadcast);
  const rawTracks = queue?.queue_tracks ?? queue?.tracks ?? [];
  if (!Array.isArray(rawTracks)) {
    throw new Error('Stationhead buddy playback queue tracks are not an array');
  }
  const limit = Math.min(rawTracks.length, Math.max(0, Math.trunc(Number(maxTracks) || 0)));
  const tracks = new Array(limit);
  for (let index = 0; index < limit; index += 1) {
    const item = rawTracks[index];
    const track = item?.track || item || {};
    const artist = track?.artist || track?.artists?.[0] || {};
    const album = track?.album || {};
    tracks[index] = {
      position: finiteNumber(item?.position, index),
      queue_track_id: finiteNumber(item?.id),
      stationhead_track_id: finiteNumber(track?.id),
      spotify_id: text(track?.spotify_id),
      deezer_id: text(track?.deezer_id),
      isrc: text(track?.isrc),
      duration_ms: Math.max(0, finiteNumber(track?.duration_ms ?? track?.duration, 0)),
      preview_url: text(track?.preview_url ?? track?.preview, 2_048),
      title: text(track?.title ?? track?.name),
      artist: text(typeof artist === 'string' ? artist : (artist?.name ?? track?.artist_name)),
      album_name: text(album?.name ?? track?.album_name),
      thumbnail_url: trackThumbnail(item, track),
    };
  }
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
  const tracks = queue.tracks;
  const length = tracks.length;
  if (!length) return -1;
  if (!queue.start_time) return 0;
  const elapsed = Math.max(0, now - queue.start_time);
  let cursor = 0;
  for (let index = 0; index < length; index += 1) {
    const duration = Math.max(0, finiteNumber(tracks[index]?.duration_ms, 0));
    if (elapsed < cursor + duration || index === length - 1) return index;
    cursor += duration;
  }
  return length - 1;
}
