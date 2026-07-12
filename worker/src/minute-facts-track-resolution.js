import {
  aliasKey,
  buildTrackDescriptor,
  chunks,
  integer,
  text,
  unique,
} from './minute-facts-track-descriptor.js';
import {
  minuteBucket,
  queueStructuralHash,
  queueStructurePayload,
  timestampMs,
} from './minute-facts-store.js';

const D1_BATCH_SIZE = 35;
const SLOW_STAGE_MS = 250;

export async function timedStage(stage, context, operation) {
  const startedAt = Date.now();
  let outcome = 'success';
  try {
    return await operation();
  } catch (error) {
    outcome = 'error';
    throw error;
  } finally {
    const durationMs = Date.now() - startedAt;
    if (outcome === 'error' || durationMs >= SLOW_STAGE_MS) {
      console.log(JSON.stringify({
        event: 'minute_fact_stage_timing',
        stage,
        outcome,
        duration_ms: durationMs,
        channel_id: context?.channelId ?? null,
        minute_at: context?.minuteAt ?? null,
        queue_tracks: context?.queueTracks ?? 0,
        revision_id: context?.revisionId ?? null,
      }));
    }
  }
}

export async function batchRun(db, statements, chunkSize = D1_BATCH_SIZE) {
  for (let index = 0; index < statements.length; index += chunkSize) {
    await db.batch(statements.slice(index, index + chunkSize));
  }
}

async function loadTrackMetadata(oldDb, tracks) {
  if (!oldDb) return new Map();
  const ids = unique((tracks || []).map((track) => text(track?.spotify_id)));
  if (!ids.length) return new Map();
  const metadata = new Map();
  for (const part of chunks(ids)) {
    const placeholders = part.map(() => '?').join(',');
    try {
      const result = await oldDb.prepare(`SELECT spotify_id,title,artist FROM sh_track_metadata
        WHERE spotify_id IN (${placeholders})`).bind(...part).all();
      for (const row of result.results || []) metadata.set(String(row.spotify_id), row);
    } catch {
      return metadata;
    }
  }
  return metadata;
}

async function loadAliasMap(db, descriptors) {
  const groups = new Map();
  for (const descriptor of descriptors) {
    for (const alias of descriptor.aliases) {
      if (!groups.has(alias.type)) groups.set(alias.type, new Set());
      groups.get(alias.type).add(alias.value);
    }
  }
  const resultMap = new Map();
  for (const [type, valuesSet] of groups) {
    const values = [...valuesSet];
    for (const part of chunks(values)) {
      const placeholders = part.map(() => '?').join(',');
      const result = await db.prepare(`SELECT alias_type,alias_value,track_id FROM sh_track_aliases
        WHERE alias_type=? AND alias_value IN (${placeholders})`).bind(type, ...part).all();
      for (const row of result.results || []) {
        resultMap.set(aliasKey(row.alias_type, row.alias_value), Number(row.track_id));
      }
    }
  }
  return resultMap;
}

async function loadTrackColumnMap(db, column, values) {
  const allowed = new Set(['canonical_key', 'isrc', 'spotify_id']);
  if (!allowed.has(column)) throw new Error(`unsupported track lookup column: ${column}`);
  const resultMap = new Map();
  for (const part of chunks(unique(values))) {
    if (!part.length) continue;
    const placeholders = part.map(() => '?').join(',');
    const result = await db.prepare(`SELECT id,${column} AS lookup_value FROM sh_tracks
      WHERE ${column} IN (${placeholders})`).bind(...part).all();
    for (const row of result.results || []) {
      if (row.lookup_value != null) resultMap.set(String(row.lookup_value), Number(row.id));
    }
  }
  return resultMap;
}

function assignKnownTrackIds(descriptors, maps) {
  for (const descriptor of descriptors) {
    if (descriptor.trackId != null) continue;
    for (const alias of descriptor.aliases) {
      const id = maps.aliases.get(aliasKey(alias.type, alias.value));
      if (Number.isFinite(id)) {
        descriptor.trackId = id;
        break;
      }
    }
    if (descriptor.trackId == null && descriptor.isrc) {
      descriptor.trackId = maps.isrc.get(descriptor.isrc) ?? null;
    }
    if (descriptor.trackId == null && descriptor.spotify_id) {
      descriptor.trackId = maps.spotify.get(descriptor.spotify_id) ?? null;
    }
    if (descriptor.trackId == null && descriptor.canonicalKey) {
      descriptor.trackId = maps.canonical.get(descriptor.canonicalKey) ?? null;
    }
  }
}

export async function resolveTracksBulk(db, oldDb, tracks, observedAt, context = {}) {
  const metadata = await timedStage('load_track_metadata', context, () => loadTrackMetadata(oldDb, tracks));
  const descriptors = (tracks || []).map((track, index) => buildTrackDescriptor(
    track,
    metadata.get(String(track?.spotify_id || '')) || {},
    index,
  ));

  const aliases = await timedStage('load_track_aliases', context, () => loadAliasMap(db, descriptors));
  const [isrc, spotify, canonical] = await timedStage('load_track_identities', context, () => Promise.all([
    loadTrackColumnMap(db, 'isrc', descriptors.map((track) => track.isrc)),
    loadTrackColumnMap(db, 'spotify_id', descriptors.map((track) => track.spotify_id)),
    loadTrackColumnMap(db, 'canonical_key', descriptors.map((track) => track.canonicalKey)),
  ]));
  assignKnownTrackIds(descriptors, { aliases, isrc, spotify, canonical });

  const unresolvedByCanonical = new Map();
  for (const descriptor of descriptors) {
    if (descriptor.trackId == null && descriptor.canonicalKey && !unresolvedByCanonical.has(descriptor.canonicalKey)) {
      unresolvedByCanonical.set(descriptor.canonicalKey, descriptor);
    }
  }
  const unresolved = [...unresolvedByCanonical.values()];
  if (unresolved.length) {
    await timedStage('insert_missing_tracks', context, () => batchRun(db, unresolved.map((track) => db.prepare(`INSERT OR IGNORE INTO sh_tracks(
        canonical_key,isrc,spotify_id,stationhead_track_id,title,artist,first_seen_at,last_seen_at
      ) VALUES(?,?,?,?,?,?,?,?)`).bind(
      track.canonicalKey,
      track.isrc,
      track.spotify_id,
      track.stationhead_track_id,
      track.title,
      track.artist,
      observedAt,
      observedAt,
    ))));

    const [createdCanonical, createdIsrc, createdSpotify] = await timedStage(
      'reload_inserted_tracks',
      context,
      () => Promise.all([
        loadTrackColumnMap(db, 'canonical_key', unresolved.map((track) => track.canonicalKey)),
        loadTrackColumnMap(db, 'isrc', unresolved.map((track) => track.isrc)),
        loadTrackColumnMap(db, 'spotify_id', unresolved.map((track) => track.spotify_id)),
      ]),
    );
    assignKnownTrackIds(descriptors, {
      aliases,
      isrc: new Map([...isrc, ...createdIsrc]),
      spotify: new Map([...spotify, ...createdSpotify]),
      canonical: new Map([...canonical, ...createdCanonical]),
    });
  }

  const representativeById = new Map();
  for (const descriptor of descriptors) {
    if (Number.isFinite(descriptor.trackId) && !representativeById.has(descriptor.trackId)) {
      representativeById.set(descriptor.trackId, descriptor);
    }
  }
  const updates = [...representativeById.entries()].map(([trackId, track]) => db.prepare(`UPDATE sh_tracks SET
      isrc=COALESCE(isrc,?),spotify_id=COALESCE(spotify_id,?),
      stationhead_track_id=COALESCE(stationhead_track_id,?),
      title=COALESCE(title,?),artist=COALESCE(artist,?),last_seen_at=MAX(last_seen_at,?)
    WHERE id=?`).bind(
    track.isrc,
    track.spotify_id,
    track.stationhead_track_id,
    track.title,
    track.artist,
    observedAt,
    trackId,
  ));

  const aliasStatements = [];
  const seenAliases = new Set();
  for (const descriptor of descriptors) {
    if (!Number.isFinite(descriptor.trackId)) continue;
    for (const alias of descriptor.aliases) {
      const key = aliasKey(alias.type, alias.value);
      if (seenAliases.has(key)) continue;
      seenAliases.add(key);
      aliasStatements.push(db.prepare(`INSERT INTO sh_track_aliases(
          alias_type,alias_value,track_id,first_seen_at,last_seen_at
        ) VALUES(?,?,?,?,?) ON CONFLICT(alias_type,alias_value) DO UPDATE SET
          last_seen_at=MAX(sh_track_aliases.last_seen_at,excluded.last_seen_at)`)
        .bind(alias.type, alias.value, descriptor.trackId, observedAt, observedAt));
    }
  }
  await timedStage('update_tracks_and_aliases', context, () => batchRun(db, [...updates, ...aliasStatements]));
  return descriptors;
}

async function findReusableRevision(db, input) {
  return db.prepare(`SELECT id,status,effective_at,item_count FROM sh_queue_revisions
    WHERE channel_id=? AND structural_hash=? AND session_id IS ? AND queue_start_time IS ?
      AND status IN ('complete','pending')
    ORDER BY CASE status WHEN 'complete' THEN 0 ELSE 1 END,effective_at DESC,id DESC
    LIMIT 1`)
    .bind(input.channelId, input.structuralHash, input.sessionId, input.queueStart)
    .first();
}

export function missingRevisionPositions(tracks, existingRows = []) {
  const existing = new Set((existingRows || []).map((row) => integer(row.position)).filter((value) => value != null));
  return (tracks || []).filter((track) => !existing.has(integer(track.position)));
}

export async function createOptimizedRevision(db, oldDb, input) {
  const { channelId, stationId, sessionId, queue, observedAt, receivedAt } = input;
  const payload = queueStructurePayload(queue);
  const structuralHash = await queueStructuralHash(queue);
  const queueStart = timestampMs(queue?.start_time);
  const context = {
    channelId,
    minuteAt: minuteBucket(observedAt),
    queueTracks: payload.tracks.length,
    revisionId: null,
  };

  let revision = await timedStage('find_queue_revision', context, () => findReusableRevision(db, {
    channelId,
    sessionId,
    queueStart,
    structuralHash,
  }));
  if (revision?.status === 'complete') {
    return { revisionId: Number(revision.id), created: false, resumed: false };
  }

  if (!revision) {
    await timedStage('insert_queue_revision', context, () => db.prepare(`INSERT OR IGNORE INTO sh_queue_revisions(
        session_id,channel_id,station_id,queue_id,queue_start_time,effective_at,received_at,
        structural_hash,item_count,status,source,source_priority
      ) VALUES(?,?,?,?,?,?,?,?,?,'pending','live_collector',100)`)
      .bind(
        sessionId,
        channelId,
        stationId,
        integer(queue?.queue_id),
        queueStart,
        observedAt,
        receivedAt,
        structuralHash,
        payload.tracks.length,
      )
      .run());
    revision = await db.prepare(`SELECT id,status,effective_at,item_count FROM sh_queue_revisions
      WHERE channel_id=? AND effective_at=? AND structural_hash=?`)
      .bind(channelId, observedAt, structuralHash)
      .first();
  }

  const revisionId = Number(revision?.id);
  if (!Number.isFinite(revisionId)) throw new Error('failed to create or resume queue revision');
  context.revisionId = revisionId;

  const existingResult = await timedStage('load_revision_progress', context, () => db.prepare(
    'SELECT position FROM sh_queue_revision_items WHERE revision_id=?',
  ).bind(revisionId).all());
  const existingRows = existingResult.results || [];
  const resolved = await resolveTracksBulk(db, oldDb, payload.tracks, observedAt, context);
  let offset = 0;
  let scheduleValid = true;
  const scheduled = resolved.map((track) => {
    const duration = integer(track.duration_ms);
    const validItem = scheduleValid && duration != null && duration > 0;
    const result = {
      ...track,
      playbackOffset: scheduleValid ? offset : null,
      scheduleValid: validItem,
    };
    if (validItem) offset += duration;
    else scheduleValid = false;
    return result;
  });

  const missing = missingRevisionPositions(scheduled, existingRows);
  const byPosition = new Map((queue?.tracks || []).map((track, index) => [integer(track?.position) ?? index, track]));
  const statements = missing.map((track) => db.prepare(`INSERT INTO sh_queue_revision_items(
      revision_id,position,track_id,queue_track_id,stationhead_track_id,isrc,spotify_id,
      deezer_id,duration_ms,playback_offset_ms,schedule_valid,bite_count
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(revision_id,position) DO UPDATE SET
      track_id=excluded.track_id,queue_track_id=excluded.queue_track_id,
      stationhead_track_id=excluded.stationhead_track_id,isrc=excluded.isrc,
      spotify_id=excluded.spotify_id,deezer_id=excluded.deezer_id,
      duration_ms=excluded.duration_ms,playback_offset_ms=excluded.playback_offset_ms,
      schedule_valid=excluded.schedule_valid,bite_count=excluded.bite_count`).bind(
    revisionId,
    track.position,
    track.trackId,
    track.queue_track_id,
    track.stationhead_track_id,
    track.isrc,
    track.spotify_id,
    track.deezer_id,
    track.duration_ms,
    track.playbackOffset,
    track.scheduleValid ? 1 : 0,
    integer(byPosition.get(track.position)?.bite_count),
  ));
  if (statements.length) {
    await timedStage('write_revision_items', context, () => batchRun(db, statements));
  }

  const count = await db.prepare('SELECT COUNT(*) AS item_count FROM sh_queue_revision_items WHERE revision_id=?')
    .bind(revisionId)
    .first();
  if (Number(count?.item_count || 0) !== payload.tracks.length) {
    throw new Error(`queue revision ${revisionId} incomplete: ${Number(count?.item_count || 0)}/${payload.tracks.length}`);
  }
  await timedStage('complete_queue_revision', context, () => db.prepare(
    "UPDATE sh_queue_revisions SET status='complete' WHERE id=?",
  ).bind(revisionId).run());
  return {
    revisionId,
    created: !revision?.id,
    resumed: existingRows.length > 0,
  };
}
