import {
  buildTrackDescriptor,
  integer,
  text,
} from './minute-facts-track-descriptor.js';
import { resolveTracksBulk } from './minute-facts-track-resolution.js';

function lookupStatement(db, descriptor) {
  const aliases = Array.isArray(descriptor.aliases) ? descriptor.aliases : [];
  const bindings = [];
  const ctes = [];
  if (aliases.length) {
    const rows = aliases.map((_alias, index) => {
      bindings.push(index, aliases[index].type, aliases[index].value);
      return '(?,?,?)';
    });
    ctes.push(`wanted(ord,alias_type,alias_value) AS (VALUES ${rows.join(',')})`);
  }

  const candidates = [];
  if (aliases.length) {
    candidates.push(`SELECT w.ord AS priority,a.track_id AS id
      FROM wanted w JOIN sh_track_aliases a
        ON a.alias_type=w.alias_type AND a.alias_value=w.alias_value`);
  }
  const direct = [];
  if (descriptor.isrc) {
    direct.push('isrc=?');
    bindings.push(descriptor.isrc);
  }
  if (descriptor.spotify_id) {
    direct.push('spotify_id=?');
    bindings.push(descriptor.spotify_id);
  }
  if (descriptor.stationhead_track_id != null) {
    direct.push('stationhead_track_id=?');
    bindings.push(descriptor.stationhead_track_id);
  }
  if (descriptor.canonicalKey) {
    direct.push('canonical_key=?');
    bindings.push(descriptor.canonicalKey);
  }
  if (direct.length) {
    candidates.push(`SELECT 100 AS priority,id FROM sh_tracks WHERE ${direct.join(' OR ')}`);
  }
  if (!candidates.length) return null;
  const withClause = ctes.length ? `WITH ${ctes.join(',')},` : 'WITH';
  return db.prepare(`${withClause} candidates AS (
      ${candidates.join('\n      UNION ALL\n      ')}
    ) SELECT id FROM candidates ORDER BY priority ASC,id ASC LIMIT 1`)
    .bind(...bindings);
}

async function lookupTrackId(db, descriptor) {
  const statement = lookupStatement(db, descriptor);
  if (!statement) return null;
  const row = await statement.first();
  const id = integer(row?.id);
  return id == null ? null : id;
}

async function insertMissingTrack(db, descriptor, observedAt) {
  if (!descriptor.canonicalKey) return;
  await db.prepare(`INSERT OR IGNORE INTO sh_tracks(
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
    )
    .run();
}

async function updateTrackAndAliases(db, descriptor, observedAt) {
  if (descriptor.trackId == null) return;
  const statements = [db.prepare(`UPDATE sh_tracks SET
      isrc=COALESCE(isrc,?),spotify_id=COALESCE(spotify_id,?),
      stationhead_track_id=COALESCE(stationhead_track_id,?),
      title=COALESCE(title,?),artist=COALESCE(artist,?),last_seen_at=MAX(last_seen_at,?)
    WHERE id=?`)
    .bind(
      descriptor.isrc,
      descriptor.spotify_id,
      descriptor.stationhead_track_id,
      descriptor.title,
      descriptor.artist,
      observedAt,
      descriptor.trackId,
    )];
  for (const alias of descriptor.aliases || []) {
    statements.push(db.prepare(`INSERT INTO sh_track_aliases(
        alias_type,alias_value,track_id,first_seen_at,last_seen_at
      ) VALUES(?,?,?,?,?) ON CONFLICT(alias_type,alias_value) DO UPDATE SET
        last_seen_at=MAX(sh_track_aliases.last_seen_at,excluded.last_seen_at)`)
      .bind(alias.type, alias.value, descriptor.trackId, observedAt, observedAt));
  }
  await db.batch(statements);
}

export async function resolveSparseTracks(db, oldDb, tracks, observedAt, context = {}) {
  if (!Array.isArray(tracks) || tracks.length !== 1) {
    return resolveTracksBulk(db, oldDb, tracks, observedAt, context);
  }
  const descriptor = buildTrackDescriptor(tracks[0], {}, integer(tracks[0]?.position) ?? 0);
  descriptor.trackId = await lookupTrackId(db, descriptor);
  if (descriptor.trackId == null) {
    await insertMissingTrack(db, descriptor, observedAt);
    descriptor.trackId = await lookupTrackId(db, descriptor);
  }
  await updateTrackAndAliases(db, descriptor, observedAt);
  return [descriptor];
}

export function sparseAliasLookupShape(track) {
  const descriptor = buildTrackDescriptor(track, {}, integer(track?.position) ?? 0);
  return {
    aliases: descriptor.aliases.map((alias, index) => ({ index, ...alias })),
    direct: {
      isrc: text(descriptor.isrc),
      spotify_id: text(descriptor.spotify_id),
      stationhead_track_id: integer(descriptor.stationhead_track_id),
      canonical_key: text(descriptor.canonicalKey),
    },
  };
}
