import {
  aliasKey,
  buildTrackDescriptor,
  chunks,
  integer,
  text,
  unique,
} from './minute-facts-track-descriptor.js';

const D1_SAFE_BOUND_PARAMETERS = 80;
const IDENTITY_BINDINGS_PER_DESCRIPTOR = 4;
const TRACK_INSERT_BINDINGS = 8;
const TRACK_UPDATE_BINDINGS = 8;
const ALIAS_UPSERT_BINDINGS = 6;
const ALIAS_VALUE_CHUNK_SIZE = D1_SAFE_BOUND_PARAMETERS - 1;
const IDENTITY_DESCRIPTOR_CHUNK_SIZE = Math.floor(
  D1_SAFE_BOUND_PARAMETERS / IDENTITY_BINDINGS_PER_DESCRIPTOR,
);
const TRACK_INSERT_BATCH_LIMIT = Math.floor(D1_SAFE_BOUND_PARAMETERS / TRACK_INSERT_BINDINGS);
const TRACK_UPDATE_BATCH_LIMIT = Math.floor(D1_SAFE_BOUND_PARAMETERS / TRACK_UPDATE_BINDINGS);
const ALIAS_UPSERT_BATCH_LIMIT = Math.floor(D1_SAFE_BOUND_PARAMETERS / ALIAS_UPSERT_BINDINGS);
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

function aliasValuesByType(descriptors) {
  const grouped = new Map();
  for (const alias of aliasPairs(descriptors)) {
    const values = grouped.get(alias.type) || [];
    values.push(alias.value);
    grouped.set(alias.type, values);
  }
  return grouped;
}

async function loadAliasMap(db, descriptors) {
  const result = new Map();
  for (const [aliasType, values] of aliasValuesByType(descriptors)) {
    for (const part of chunks(values, ALIAS_VALUE_CHUNK_SIZE)) {
      const placeholders = part.map(() => '?').join(',');
      const rows = await db.prepare(`SELECT alias_type,alias_value,track_id
        FROM sh_track_aliases
        WHERE alias_type=? AND alias_value IN (${placeholders})`)
        .bind(aliasType, ...part).all();
      for (const row of rows.results || []) {
        result.set(aliasKey(row.alias_type, row.alias_value), integer(row.track_id));
      }
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

async function runStatementBatches(db, statements, statementLimit) {
  for (const part of chunks(statements, statementLimit)) {
    if (part.length) await db.batch(part);
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
  await runStatementBatches(db, statements, TRACK_INSERT_BATCH_LIMIT);
}

function trackRefreshConditions(descriptor) {
  const conditions = [];
  if (descriptor.isrc != null) conditions.push('isrc IS NULL');
  if (descriptor.spotify_id != null) conditions.push('spotify_id IS NULL');
  if (descriptor.stationhead_track_id != null) conditions.push('stationhead_track_id IS NULL');
  if (descriptor.title != null) conditions.push('title IS NULL');
  if (descriptor.artist != null) conditions.push('artist IS NULL');
  conditions.push('last_seen_at<=?');
  return conditions.join('\n        OR ');
}

async function persistTrackAliases(db, descriptors, observedAt) {
  const uniqueTracks = new Map();
  for (const descriptor of descriptors) {
    if (descriptor.trackId != null && !uniqueTracks.has(descriptor.trackId)) {
      uniqueTracks.set(descriptor.trackId, descriptor);
    }
  }
  const trackStatements = [];
  const aliasStatements = [];
  for (const descriptor of uniqueTracks.values()) {
    trackStatements.push(db.prepare(`UPDATE sh_tracks SET
        isrc=COALESCE(isrc,?),spotify_id=COALESCE(spotify_id,?),
        stationhead_track_id=COALESCE(stationhead_track_id,?),
        title=COALESCE(title,?),artist=COALESCE(artist,?),last_seen_at=MAX(last_seen_at,?)
      WHERE id=? AND (
        ${trackRefreshConditions(descriptor)}
      )`)
      .bind(
        descriptor.isrc,
        descriptor.spotify_id,
        descriptor.stationhead_track_id,
        descriptor.title,
        descriptor.artist,
        observedAt,
        descriptor.trackId,
        observedAt - TRACK_SEEN_CHECKPOINT_MS,
      ));
    for (const alias of descriptor.aliases || []) {
      aliasStatements.push(db.prepare(`INSERT INTO sh_track_aliases(
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
  await runSubstage(
    'persist_track_rows',
    () => runStatementBatches(db, trackStatements, TRACK_UPDATE_BATCH_LIMIT),
  );
  await runSubstage(
    'persist_alias_rows',
    () => runStatementBatches(db, aliasStatements, ALIAS_UPSERT_BATCH_LIMIT),
  );
}

async function runSubstage(name, operation) {
  try {
    return await operation();
  } catch (error) {
    const wrapped = new Error(`${name}: ${String(error?.message || error)}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

export async function resolveTracksAliasFirst(db, fallbackDb, tracks, observedAt) {
  if (!Array.isArray(tracks) || !tracks.length) return [];
  let descriptors = tracks.map((track, index) => buildTrackDescriptor(track, {}, index));
  assignAliases(descriptors, await runSubstage(
    'load_alias_map_initial',
    () => loadAliasMap(db, descriptors),
  ));

  const unresolvedIndexes = [];
  for (let index = 0; index < descriptors.length; index += 1) {
    if (descriptors[index].trackId == null) unresolvedIndexes.push(index);
  }
  if (unresolvedIndexes.length) {
    const unresolved = unresolvedIndexes.map((index) => descriptors[index]);
    const metadata = await runSubstage(
      'load_unresolved_metadata',
      () => loadUnresolvedMetadata(db, fallbackDb, unresolved),
    );
    descriptors = descriptors.map((descriptor, index) => {
      if (!unresolvedIndexes.includes(index)) return descriptor;
      const spotifyId = text(tracks[index]?.spotify_id);
      return buildTrackDescriptor(tracks[index], spotifyId ? metadata.get(spotifyId) : {}, index);
    });
    const enrichedUnresolved = descriptors.filter((descriptor) => descriptor.trackId == null);
    assignAliases(enrichedUnresolved, await runSubstage(
      'load_alias_map_enriched',
      () => loadAliasMap(db, enrichedUnresolved),
    ));
  }

  const stillMissing = descriptors.filter((descriptor) => descriptor.trackId == null);
  if (stillMissing.length) {
    await runSubstage('insert_tracks', () => insertTracks(db, stillMissing, observedAt));
    const identities = await runSubstage(
      'load_track_identity_map',
      () => loadTrackIdentityMap(db, stillMissing),
    );
    assignTrackRows(stillMissing, identities);
  }
  const unresolved = descriptors.filter((descriptor) => descriptor.trackId == null);
  if (unresolved.length) {
    throw new Error(`failed to resolve ${unresolved.length} queue track identities`);
  }
  await runSubstage('persist_track_aliases', () => persistTrackAliases(db, descriptors, observedAt));
  return descriptors;
}
