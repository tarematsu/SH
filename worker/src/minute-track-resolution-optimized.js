import {
  aliasKey,
  buildTrackDescriptor,
  chunks,
  integer,
  text,
  unique,
} from './minute-facts-track-descriptor.js';

const D1_MAX_BOUND_PARAMETERS = 100;
const ALIAS_BINDINGS_PER_PAIR = 2;
const IDENTITY_BINDINGS_PER_DESCRIPTOR = 4;
const ALIAS_CHUNK_SIZE = Math.floor(D1_MAX_BOUND_PARAMETERS / ALIAS_BINDINGS_PER_PAIR);
const IDENTITY_DESCRIPTOR_CHUNK_SIZE = Math.floor(
  D1_MAX_BOUND_PARAMETERS / IDENTITY_BINDINGS_PER_DESCRIPTOR,
);
const TRACK_SEEN_CHECKPOINT_MS = 24 * 60 * 60_000;

function normalizedIsrc(value) {
  return text(value)?.toUpperCase() || null;
}

function mergeMetadata(current, fallback) {
  if (!fallback) return current || {};
  if (!current) return fallback;
  return {
    ...fallback,
    ...current,
    title: current.title || fallback.title || null,
    artist: current.artist || fallback.artist || null,
  };
}

async function metadataRows(db, spotifyIds) {
  if (!db?.prepare || !spotifyIds.length) return [];
  const rows = [];
  for (const part of chunks(spotifyIds)) {
    const placeholders = part.map(() => '?').join(',');
    const result = await db.prepare(`SELECT spotify_id,title,artist
      FROM sh_track_metadata WHERE spotify_id IN (${placeholders})`)
      .bind(...part).all();
    rows.push(...(result.results || []));
  }
  return rows;
}

async function loadUnresolvedMetadata(db, fallbackDb, descriptors) {
  const spotifyIds = unique(descriptors.map((descriptor) => text(descriptor.spotify_id)));
  if (!spotifyIds.length) return new Map();
  let primaryRows = [];
  try {
    primaryRows = await metadataRows(db, spotifyIds);
  } catch (error) {
    if (!/no such table|no such column/i.test(String(error?.message || ''))) throw error;
  }
  const primary = new Map(primaryRows.map((row) => [String(row.spotify_id), row]));
  const incomplete = spotifyIds.filter((spotifyId) => {
    const row = primary.get(String(spotifyId));
    return !row?.title || !row?.artist;
  });
  if (!fallbackDb?.prepare || fallbackDb === db || !incomplete.length) return primary;
  try {
    const fallbackRows = await metadataRows(fallbackDb, incomplete);
    for (const row of fallbackRows) {
      const key = String(row.spotify_id);
      primary.set(key, mergeMetadata(primary.get(key), row));
    }
  } catch (error) {
    if (!/no such table|no such column/i.test(String(error?.message || ''))) throw error;
  }
  return primary;
}

function aliasPairs(descriptors) {
  const pairs = [];
  const seen = new Set();
  for (const descriptor of descriptors) {
    for (const alias of descriptor.aliases || []) {
      const key = aliasKey(alias.type, alias.value);
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push(alias);
    }
  }
  return pairs;
}

async function loadAliasMap(db, descriptors) {
  const pairs = aliasPairs(descriptors);
  const result = new Map();
  for (let offset = 0; offset < pairs.length; offset += ALIAS_CHUNK_SIZE) {
    const part = pairs.slice(offset, offset + ALIAS_CHUNK_SIZE);
    const bindings = [];
    const values = part.map((alias) => {
      bindings.push(alias.type, alias.value);
      return '(?,?)';
    });
    const rows = await db.prepare(`WITH wanted(alias_type,alias_value) AS (
        VALUES ${values.join(',')}
      )
      SELECT wanted.alias_type,wanted.alias_value,aliases.track_id
      FROM wanted
      JOIN sh_track_aliases aliases
        ON aliases.alias_type=wanted.alias_type
        AND aliases.alias_value=wanted.alias_value`)
      .bind(...bindings).all();
    for (const row of rows.results || []) {
      result.set(aliasKey(row.alias_type, row.alias_value), integer(row.track_id));
    }
  }
  return result;
}

function assignAliases(descriptors, aliases) {
  for (const descriptor of descriptors) {
    if (descriptor.trackId != null) continue;
    for (const alias of descriptor.aliases || []) {
      const trackId = aliases.get(aliasKey(alias.type, alias.value));
      if (trackId != null) {
        descriptor.trackId = trackId;
        break;
      }
    }
  }
}

function identityQuery(descriptors) {
  const canonicalKeys = unique(descriptors.map((value) => text(value.canonicalKey)));
  const isrcs = unique(descriptors.map((value) => normalizedIsrc(value.isrc)));
  const spotifyIds = unique(descriptors.map((value) => text(value.spotify_id)));
  const stationheadIds = unique(descriptors.map((value) => integer(value.stationhead_track_id)));
  const bindings = [];
  const clauses = [];
  const add = (column, values) => {
    if (!values.length) return;
    clauses.push(`${column} IN (${values.map(() => '?').join(',')})`);
    bindings.push(...values);
  };
  add('canonical_key', canonicalKeys);
  add('isrc', isrcs);
  add('spotify_id', spotifyIds);
  add('stationhead_track_id', stationheadIds);
  return clauses.length ? { clauses, bindings } : null;
}

function addTrackIdentityRows(map, rows) {
  for (const row of rows || []) {
    const id = integer(row.id);
    if (id == null) continue;
    if (row.canonical_key) map.set(`canonical:${row.canonical_key}`, id);
    const isrc = normalizedIsrc(row.isrc);
    if (isrc) map.set(aliasKey('isrc', isrc), id);
    const spotifyId = text(row.spotify_id);
    if (spotifyId) map.set(aliasKey('spotify_id', spotifyId), id);
    const stationheadId = integer(row.stationhead_track_id);
    if (stationheadId != null) map.set(aliasKey('stationhead_track_id', String(stationheadId)), id);
  }
}

async function loadTrackIdentityMap(db, descriptors) {
  const map = new Map();
  for (const part of chunks(descriptors, IDENTITY_DESCRIPTOR_CHUNK_SIZE)) {
    const query = identityQuery(part);
    if (!query) continue;
    const result = await db.prepare(`SELECT id,canonical_key,isrc,spotify_id,stationhead_track_id
      FROM sh_tracks WHERE ${query.clauses.join(' OR ')}`)
      .bind(...query.bindings).all();
    addTrackIdentityRows(map, result.results);
  }
  return map;
}

function assignTrackRows(descriptors, identities) {
  for (const descriptor of descriptors) {
    if (descriptor.trackId != null) continue;
    for (const alias of descriptor.aliases || []) {
      const id = identities.get(aliasKey(alias.type, alias.value));
      if (id != null) {
        descriptor.trackId = id;
        break;
      }
    }
    if (descriptor.trackId == null && descriptor.canonicalKey) {
      descriptor.trackId = identities.get(`canonical:${descriptor.canonicalKey}`) ?? null;
    }
  }
}

async function insertTracks(db, descriptors, observedAt) {
  const statements = descriptors
    .filter((descriptor) => descriptor.trackId == null && descriptor.canonicalKey)
    .map((descriptor) => db.prepare(`INSERT OR IGNORE INTO sh_tracks(
        canonical_key,isrc,spotify_id,stationhead_track_id,title,artist,first_seen_at,last_seen_at
      ) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(
        descriptor.canonicalKey,
        descriptor.isrc,
        descriptor.spotify_id,
        descriptor.stationhead_track_id,
        descriptor.title,
        descriptor.artist,
        observedAt,
        observedAt,
      ));
  if (statements.length) await db.batch(statements);
}

async function persistTrackAliases(db, descriptors, observedAt) {
  const uniqueTracks = new Map();
  for (const descriptor of descriptors) {
    if (descriptor.trackId != null && !uniqueTracks.has(descriptor.trackId)) {
      uniqueTracks.set(descriptor.trackId, descriptor);
    }
  }
  const statements = [];
  for (const descriptor of uniqueTracks.values()) {
    statements.push(db.prepare(`UPDATE sh_tracks SET
        isrc=COALESCE(isrc,?),spotify_id=COALESCE(spotify_id,?),
        stationhead_track_id=COALESCE(stationhead_track_id,?),
        title=COALESCE(title,?),artist=COALESCE(artist,?),last_seen_at=MAX(last_seen_at,?)
      WHERE id=? AND (
        (isrc IS NULL AND ? IS NOT NULL)
        OR (spotify_id IS NULL AND ? IS NOT NULL)
        OR (stationhead_track_id IS NULL AND ? IS NOT NULL)
        OR (title IS NULL AND ? IS NOT NULL)
        OR (artist IS NULL AND ? IS NOT NULL)
        OR last_seen_at<=?
      )`)
      .bind(
        descriptor.isrc,
        descriptor.spotify_id,
        descriptor.stationhead_track_id,
        descriptor.title,
        descriptor.artist,
        observedAt,
        descriptor.trackId,
        descriptor.isrc,
        descriptor.spotify_id,
        descriptor.stationhead_track_id,
        descriptor.title,
        descriptor.artist,
        observedAt - TRACK_SEEN_CHECKPOINT_MS,
      ));
    for (const alias of descriptor.aliases || []) {
      statements.push(db.prepare(`INSERT INTO sh_track_aliases(
          alias_type,alias_value,track_id,first_seen_at,last_seen_at
        ) VALUES(?,?,?,?,?) ON CONFLICT(alias_type,alias_value) DO UPDATE SET
          last_seen_at=excluded.last_seen_at
        WHERE excluded.track_id=sh_track_aliases.track_id
          AND excluded.last_seen_at-sh_track_aliases.last_seen_at>=?`)
        .bind(
          alias.type,
          alias.value,
          descriptor.trackId,
          observedAt,
          observedAt,
          TRACK_SEEN_CHECKPOINT_MS,
        ));
    }
  }
  if (statements.length) await db.batch(statements);
}

export async function resolveTracksAliasFirst(db, fallbackDb, tracks, observedAt) {
  if (!Array.isArray(tracks) || !tracks.length) return [];
  let descriptors = tracks.map((track, index) => buildTrackDescriptor(track, {}, index));
  assignAliases(descriptors, await loadAliasMap(db, descriptors));

  const unresolvedIndexes = [];
  for (let index = 0; index < descriptors.length; index += 1) {
    if (descriptors[index].trackId == null) unresolvedIndexes.push(index);
  }
  if (unresolvedIndexes.length) {
    const unresolved = unresolvedIndexes.map((index) => descriptors[index]);
    const metadata = await loadUnresolvedMetadata(db, fallbackDb, unresolved);
    descriptors = descriptors.map((descriptor, index) => {
      if (!unresolvedIndexes.includes(index)) return descriptor;
      const spotifyId = text(tracks[index]?.spotify_id);
      return buildTrackDescriptor(tracks[index], spotifyId ? metadata.get(spotifyId) : {}, index);
    });
    const enrichedUnresolved = descriptors.filter((descriptor) => descriptor.trackId == null);
    assignAliases(enrichedUnresolved, await loadAliasMap(db, enrichedUnresolved));
  }

  const stillMissing = descriptors.filter((descriptor) => descriptor.trackId == null);
  if (stillMissing.length) {
    await insertTracks(db, stillMissing, observedAt);
    assignTrackRows(stillMissing, await loadTrackIdentityMap(db, stillMissing));
  }
  const unresolved = descriptors.filter((descriptor) => descriptor.trackId == null);
  if (unresolved.length) {
    throw new Error(`failed to resolve ${unresolved.length} queue track identities`);
  }
  await persistTrackAliases(db, descriptors, observedAt);
  return descriptors;
}
