function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function integer(value) {
  const parsed = num(value);
  return parsed == null ? null : Math.trunc(parsed);
}

export function text(value) {
  if (value === null || value === undefined) return null;
  const parsed = String(value).trim();
  return parsed || null;
}

export function bool(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value === 0 ? 0 : 1;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return 1;
  if (['false', '0', 'no', 'off', ''].includes(normalized)) return 0;
  return null;
}

function normalizedIsrc(value) {
  return text(value)?.toUpperCase() || null;
}

function normalizedLegacyTrack(title, artist) {
  const titleKey = text(title)?.toLowerCase() || '';
  const artistKey = text(artist)?.toLowerCase() || '';
  return titleKey || artistKey ? `${titleKey}\u001f${artistKey}` : null;
}

const LOOKUP_CHUNK_SIZE = 70;

export function chunks(values, size = LOOKUP_CHUNK_SIZE) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))];
}

export function aliasKey(type, value) {
  return `${type}:${value}`;
}

function trackAliases(source = {}) {
  const isrc = normalizedIsrc(source.isrc);
  const spotifyId = text(source.spotifyId ?? source.spotify_id);
  const stationheadId = integer(source.stationheadId ?? source.stationhead_track_id);
  const legacyId = integer(source.legacyId ?? source.legacy_track_id);
  const title = text(source.title);
  const artist = text(source.artist ?? source.artist_name);
  const legacyName = normalizedLegacyTrack(title, artist);
  const aliases = [
    isrc ? { type: 'isrc', value: isrc } : null,
    spotifyId ? { type: 'spotify_id', value: spotifyId } : null,
    stationheadId == null ? null : { type: 'stationhead_track_id', value: String(stationheadId) },
    legacyId == null ? null : { type: 'legacy_track_id', value: String(legacyId) },
    legacyName ? { type: 'legacy_name', value: legacyName } : null,
  ].filter(Boolean);
  const seen = new Set();
  return aliases.filter((alias) => {
    const key = aliasKey(alias.type, alias.value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildTrackDescriptor(track = {}, details = {}, fallbackPosition = 0) {
  const source = {
    ...track,
    title: text(track.title) || text(details.title),
    artist: text(track.artist ?? track.artist_name) || text(details.artist),
  };
  const aliases = trackAliases(source);
  return {
    ...track,
    position: integer(track.position) ?? fallbackPosition,
    isrc: normalizedIsrc(track.isrc),
    spotify_id: text(track.spotify_id),
    stationhead_track_id: integer(track.stationhead_track_id),
    title: text(source.title),
    artist: text(source.artist),
    aliases,
    canonicalKey: aliases.length ? aliasKey(aliases[0].type, aliases[0].value) : null,
    trackId: null,
  };
}
