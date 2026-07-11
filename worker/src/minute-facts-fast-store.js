import { saveMinuteFactWithinBudget } from './minute-facts-write-budget.js';
import {
  FACT_QUALITY_FLAGS,
  minuteBucket,
  MINUTE_FACT_SOURCE_CODES,
  queueStructuralHash,
  queueStructurePayload,
  qualityScore,
  reportedStreamCount,
  resolveHost,
  resolveLiveSession,
  timestampMs,
  TRACK_DETECTION_METHOD_CODES,
  upsertMinuteFact,
} from './minute-facts-store.js';

const LOOKUP_CHUNK_SIZE = 70;
const D1_BATCH_SIZE = 35;
const SLOW_STAGE_MS = 250;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value) {
  const parsed = num(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function text(value) {
  if (value === null || value === undefined) return null;
  const parsed = String(value).trim();
  return parsed || null;
}

function bool(value) {
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

function chunks(values, size = LOOKUP_CHUNK_SIZE) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))];
}

function aliasKey(type, value) {
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

async function timedStage(stage, context, operation) {
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

async function batchRun(db, statements, chunkSize = D1_BATCH_SIZE) {
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

async function updatePlaybackState(db, input) {
  const { channelId, sessionId, revisionId, queueStartTime, observedAt, isPaused } = input;
  const previous = await db.prepare('SELECT * FROM sh_playback_current WHERE channel_id=?')
    .bind(channelId).first();
  const paused = bool(isPaused) === 1;
  const delayed = previous && observedAt < Number(previous.last_observed_at || 0);
  if (delayed) return { ...previous, delayed: true };

  const revisionChanged = Number(previous?.revision_id || 0) !== Number(revisionId || 0);
  let pausedTotal = revisionChanged ? 0 : Number(previous?.paused_total_ms || 0);
  let pauseStartedAt = revisionChanged ? (paused ? observedAt : null) : integer(previous?.pause_started_at);
  const wasPaused = revisionChanged ? false : Number(previous?.is_paused || 0) === 1;
  if (!revisionChanged && !wasPaused && paused) pauseStartedAt = observedAt;
  if (!revisionChanged && wasPaused && !paused) {
    if (pauseStartedAt != null) pausedTotal += Math.max(0, observedAt - pauseStartedAt);
    pauseStartedAt = null;
  }
  if (revisionChanged || wasPaused !== paused) {
    await db.prepare(`INSERT OR IGNORE INTO sh_queue_state_events(
      revision_id,observed_at,is_paused,source
    ) VALUES(?,?,?,'live_collector')`).bind(revisionId, observedAt, paused ? 1 : 0).run();
  }

  const activePause = paused && pauseStartedAt != null ? Math.max(0, observedAt - pauseStartedAt) : 0;
  const elapsed = queueStartTime == null
    ? null
    : Math.max(0, observedAt - queueStartTime - pausedTotal - activePause);
  let currentPosition = null;
  if (elapsed != null) {
    const items = await db.prepare(`SELECT position,duration_ms,playback_offset_ms,schedule_valid
      FROM sh_queue_revision_items WHERE revision_id=? ORDER BY position ASC`).bind(revisionId).all();
    const match = (items.results || []).find((item) => Number(item.schedule_valid) === 1
      && elapsed >= Number(item.playback_offset_ms)
      && elapsed < Number(item.playback_offset_ms) + Number(item.duration_ms));
    currentPosition = match?.position == null ? null : Number(match.position);
  }

  await db.prepare(`INSERT INTO sh_playback_current(
      channel_id,session_id,revision_id,queue_start_time,is_paused,paused_total_ms,
      pause_started_at,last_observed_at,current_position
    ) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET
      session_id=excluded.session_id,revision_id=excluded.revision_id,
      queue_start_time=excluded.queue_start_time,is_paused=excluded.is_paused,
      paused_total_ms=excluded.paused_total_ms,pause_started_at=excluded.pause_started_at,
      last_observed_at=excluded.last_observed_at,current_position=excluded.current_position
    WHERE excluded.last_observed_at>=sh_playback_current.last_observed_at`).bind(
    channelId,
    sessionId,
    revisionId,
    queueStartTime,
    paused ? 1 : 0,
    pausedTotal,
    pauseStartedAt,
    observedAt,
    currentPosition,
  ).run();
  return {
    revision_id: revisionId,
    is_paused: paused ? 1 : 0,
    current_position: currentPosition,
    delayed: false,
  };
}

async function writeCurrentBite(db, input) {
  const { channelId, stationId, revisionId, position, observedAt, queue } = input;
  if (position == null) return null;
  const sourceTrack = (queue?.tracks || []).find(
    (track, index) => (integer(track?.position) ?? index) === position,
  );
  const biteCount = integer(sourceTrack?.bite_count);
  if (biteCount == null) return null;
  const item = await db.prepare(`SELECT track_id FROM sh_queue_revision_items
    WHERE revision_id=? AND position=?`).bind(revisionId, position).first();
  const trackId = integer(item?.track_id);
  if (trackId == null) return biteCount;
  const latest = await db.prepare(`SELECT bite_count FROM sh_track_bite_observations
    WHERE channel_id=? AND track_id=? ORDER BY observed_at DESC,id DESC LIMIT 1`)
    .bind(channelId, trackId).first();
  if (integer(latest?.bite_count) !== biteCount) {
    await db.prepare(`INSERT OR IGNORE INTO sh_track_bite_observations(
        observed_at,channel_id,station_id,revision_id,track_id,queue_position,bite_count,source
      ) VALUES(?,?,?,?,?,?,?,'live_collector')`).bind(
      observedAt,
      channelId,
      stationId,
      revisionId,
      trackId,
      position,
      biteCount,
    ).run();
  }
  await db.prepare('UPDATE sh_queue_revision_items SET bite_count=? WHERE revision_id=? AND position=?')
    .bind(biteCount, revisionId, position).run();
  return biteCount;
}

export async function saveOptimizedLiveMinuteFact(env, input) {
  const db = env?.FACTS_DB;
  if (!db) return { skipped: true, reason: 'facts-db-binding-missing' };
  const snapshot = input.snapshot || {};
  const queue = input.queue || null;
  const observedAt = integer(input.observedAt) ?? Date.now();
  const receivedAt = Date.now();
  const channelId = integer(snapshot.channel_id);
  if (channelId == null) return { skipped: true, reason: 'channel-id-missing' };
  const stationId = integer(snapshot.station_id ?? queue?.station_id);
  const context = {
    channelId,
    minuteAt: minuteBucket(observedAt),
    queueTracks: Array.isArray(queue?.tracks) ? queue.tracks.length : 0,
    revisionId: null,
  };

  const hostId = await timedStage('resolve_host', context, () => resolveHost(db, {
    accountId: snapshot.host_account_id,
    handle: snapshot.host_handle,
  }, observedAt));
  const sessionId = await timedStage('resolve_session', context, () => resolveLiveSession(db, {
    channelId,
    stationId,
    hostId,
    broadcastStartTime: snapshot.broadcast_start_time,
    isBroadcasting: snapshot.is_broadcasting,
    observedAt,
  }));

  let revisionId = null;
  let playback = null;
  if (queue && Array.isArray(queue.tracks) && bool(snapshot.is_broadcasting) !== 0) {
    const revision = await timedStage('create_or_resume_revision', context, () => createOptimizedRevision(
      db,
      env.DB,
      { channelId, stationId, sessionId, queue, observedAt, receivedAt },
    ));
    revisionId = revision.revisionId;
    context.revisionId = revisionId;
    playback = await timedStage('update_playback', context, () => updatePlaybackState(db, {
      channelId,
      sessionId,
      revisionId,
      queueStartTime: timestampMs(queue.start_time),
      observedAt,
      isPaused: queue.is_paused,
    }));
  }

  const position = integer(playback?.current_position);
  const item = revisionId == null || position == null ? null : await db.prepare(`SELECT
      track_id,schedule_valid FROM sh_queue_revision_items WHERE revision_id=? AND position=?`)
    .bind(revisionId, position).first();
  const trackId = integer(item?.track_id);
  const biteCount = revisionId == null ? null : await timedStage('write_current_bite', context, () => writeCurrentBite(db, {
    channelId,
    stationId,
    revisionId,
    position,
    observedAt,
    queue,
  }));

  let flags = 0;
  const broadcasting = bool(snapshot.is_broadcasting);
  if (broadcasting === 0) flags |= FACT_QUALITY_FLAGS.OFFLINE;
  if (broadcasting !== 0 && !queue) flags |= FACT_QUALITY_FLAGS.QUEUE_MISSING;
  if (broadcasting !== 0 && queue && trackId == null) flags |= FACT_QUALITY_FLAGS.TRACK_UNKNOWN;
  if (trackId != null) flags |= FACT_QUALITY_FLAGS.TRACK_INFERRED;
  if (input.comments?.degraded) flags |= FACT_QUALITY_FLAGS.COMMENTS_DEGRADED;
  if (playback?.delayed) flags |= FACT_QUALITY_FLAGS.DELAYED_PAYLOAD;
  if (bool(queue?.is_paused) === 1) flags |= FACT_QUALITY_FLAGS.PAUSED;

  const fact = {
    channel_id: channelId,
    station_id: stationId,
    minute_at: minuteBucket(observedAt),
    observed_at: observedAt,
    received_at: receivedAt,
    source_code: MINUTE_FACT_SOURCE_CODES.live_collector,
    source_priority: 100,
    source_record_id: null,
    collector_id: text(env.COLLECTOR_ID) || 'cloudflare-worker',
    broadcast_session_id: sessionId,
    host_id: hostId,
    is_broadcasting: broadcasting,
    broadcast_start_time: timestampMs(snapshot.broadcast_start_time),
    listener_count: integer(snapshot.listener_count),
    online_member_count: integer(snapshot.online_member_count),
    total_member_count: integer(snapshot.total_member_count),
    guest_count: integer(snapshot.guest_count),
    reported_total_listens: integer(snapshot.total_listens),
    reported_current_stream_count: reportedStreamCount(snapshot.current_stream_count),
    validated_stream_count: null,
    stream_count_rejected: 0,
    queue_revision_id: revisionId,
    queue_id: integer(queue?.queue_id),
    queue_start_time: timestampMs(queue?.start_time),
    is_paused: bool(queue?.is_paused) === 1 ? 1 : 0,
    queue_track_count: Array.isArray(queue?.tracks) ? queue.tracks.length : null,
    queue_available: queue ? 1 : 0,
    track_id: trackId,
    queue_position: position,
    track_detection_code: trackId == null
      ? TRACK_DETECTION_METHOD_CODES.unknown
      : TRACK_DETECTION_METHOD_CODES.queue_inferred,
    track_confidence: trackId == null ? 0 : (playback?.delayed ? 0.6 : 0.9),
    schedule_valid: Number(item?.schedule_valid || 0),
    track_bite_count: biteCount,
    comment_count: integer(input.comments?.commentCount ?? input.comments?.commentsSaved),
    comment_total: integer(input.comments?.commentTotal),
    comments_degraded: input.comments?.degraded ? 1 : 0,
    quality_score: qualityScore(flags),
    quality_flags: flags,
  };
  await timedStage('upsert_minute_fact', context, () => upsertMinuteFact(db, fact));
  return { skipped: false, fact, sessionId, revisionId };
}

export function saveOptimizedMinuteFactWithinBudget(env, input) {
  return saveMinuteFactWithinBudget(env, input, saveOptimizedLiveMinuteFact);
}
