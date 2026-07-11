const MINUTE_MS = 60_000;
const SESSION_GAP_MS = 6 * 60 * 60_000;

export const FACT_QUALITY_FLAGS = Object.freeze({
  QUEUE_MISSING: 2,
  TRACK_UNKNOWN: 8,
  TRACK_INFERRED: 16,
  COMMENTS_DEGRADED: 32,
  STREAM_REJECTED: 64,
  DELAYED_PAYLOAD: 128,
  OFFLINE: 256,
  PAUSED: 512,
  LEGACY_QUALITY_REDUCED: 1024,
});

export const MINUTE_FACT_SOURCES = Object.freeze({
  1: 'live_collector',
  2: 'live_reconstructed',
  3: 'legacy_normalized',
  4: 'legacy_raw',
});
export const MINUTE_FACT_SOURCE_CODES = Object.freeze(
  Object.fromEntries(Object.entries(MINUTE_FACT_SOURCES).map(([code, name]) => [name, Number(code)])),
);
export function minuteFactSourceCode(name) {
  return MINUTE_FACT_SOURCE_CODES[name] ?? null;
}
export function minuteFactSourceName(code) {
  return MINUTE_FACT_SOURCES[Number(code)] ?? null;
}

export const TRACK_DETECTION_METHODS = Object.freeze({
  0: 'unknown',
  1: 'queue_inferred',
  2: 'queue_reconstructed',
});
export const TRACK_DETECTION_METHOD_CODES = Object.freeze(
  Object.fromEntries(Object.entries(TRACK_DETECTION_METHODS).map(([code, name]) => [name, Number(code)])),
);
export function trackDetectionMethodCode(name) {
  return TRACK_DETECTION_METHOD_CODES[name] ?? TRACK_DETECTION_METHOD_CODES.unknown;
}
export function trackDetectionMethodName(code) {
  return TRACK_DETECTION_METHODS[Number(code)] ?? TRACK_DETECTION_METHODS[0];
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value) {
  const parsed = num(value);
  return parsed == null ? null : Math.trunc(parsed);
}

export function reportedStreamCount(value) {
  const parsed = integer(value);
  return parsed != null && parsed >= 0 ? parsed : null;
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

export function minuteBucket(timestamp) {
  return Math.floor(Number(timestamp) / MINUTE_MS) * MINUTE_MS;
}

export function timestampMs(value) {
  const parsed = num(value);
  if (parsed == null) return null;
  return Math.abs(parsed) < 100_000_000_000 ? Math.trunc(parsed * 1000) : Math.trunc(parsed);
}

function normalizedHandle(value) {
  return text(value)?.toLowerCase() || null;
}

function normalizedIsrc(value) {
  return text(value)?.toUpperCase() || null;
}

function normalizedLegacyTrack(title, artist) {
  const titleKey = text(title)?.toLowerCase() || '';
  const artistKey = text(artist)?.toLowerCase() || '';
  return titleKey || artistKey ? `${titleKey}\u001f${artistKey}` : null;
}

function uniqueAliases(aliases) {
  const seen = new Set();
  return aliases.filter((alias) => {
    if (!alias?.type || !alias?.value) return false;
    const key = `${alias.type}:${alias.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function findAlias(db, table, idColumn, aliases) {
  for (const alias of aliases) {
    const row = await db.prepare(`SELECT ${idColumn} AS id FROM ${table}
      WHERE alias_type=? AND alias_value=?`).bind(alias.type, alias.value).first();
    if (row?.id != null) return Number(row.id);
  }
  return null;
}

async function upsertAliases(db, table, idColumn, entityId, aliases, observedAt) {
  for (const alias of aliases) {
    await db.prepare(`INSERT INTO ${table}(alias_type,alias_value,${idColumn},first_seen_at,last_seen_at)
      VALUES(?,?,?,?,?) ON CONFLICT(alias_type,alias_value) DO UPDATE SET
      last_seen_at=MAX(${table}.last_seen_at,excluded.last_seen_at)`)
      .bind(alias.type, alias.value, entityId, observedAt, observedAt).run();
  }
}

export async function resolveHost(db, source = {}, observedAt = Date.now()) {
  const accountId = integer(source.accountId ?? source.host_account_id);
  const handle = text(source.handle ?? source.host_handle);
  const legacyId = integer(source.legacyId ?? source.legacy_host_id);
  const aliases = uniqueAliases([
    accountId == null ? null : { type: 'stationhead_account_id', value: String(accountId) },
    legacyId == null ? null : { type: 'legacy_host_id', value: String(legacyId) },
    normalizedHandle(handle) ? { type: 'handle', value: normalizedHandle(handle) } : null,
  ]);
  if (!aliases.length) return null;

  let hostId = await findAlias(db, 'sh_host_aliases', 'host_id', aliases);
  const canonicalKey = `${aliases[0].type}:${aliases[0].value}`;
  if (hostId == null) {
    await db.prepare(`INSERT OR IGNORE INTO sh_hosts(
      canonical_key,stationhead_account_id,current_handle,first_seen_at,last_seen_at
    ) VALUES(?,?,?,?,?)`).bind(canonicalKey, accountId, handle, observedAt, observedAt).run();
    const row = await db.prepare('SELECT id FROM sh_hosts WHERE canonical_key=?')
      .bind(canonicalKey).first();
    hostId = Number(row?.id);
  }
  if (!Number.isFinite(hostId)) return null;

  await db.prepare(`UPDATE sh_hosts SET
      stationhead_account_id=COALESCE(stationhead_account_id,?),
      current_handle=COALESCE(?,current_handle),
      last_seen_at=MAX(last_seen_at,?)
    WHERE id=?`).bind(accountId, handle, observedAt, hostId).run();
  await upsertAliases(db, 'sh_host_aliases', 'host_id', hostId, aliases, observedAt);
  return hostId;
}

export async function resolveTrack(db, source = {}, observedAt = Date.now()) {
  const isrc = normalizedIsrc(source.isrc);
  const spotifyId = text(source.spotifyId ?? source.spotify_id);
  const stationheadId = integer(source.stationheadId ?? source.stationhead_track_id);
  const legacyId = integer(source.legacyId ?? source.legacy_track_id);
  const title = text(source.title);
  const artist = text(source.artist ?? source.artist_name);
  const legacyName = normalizedLegacyTrack(title, artist);
  const aliases = uniqueAliases([
    isrc ? { type: 'isrc', value: isrc } : null,
    spotifyId ? { type: 'spotify_id', value: spotifyId } : null,
    stationheadId == null ? null : { type: 'stationhead_track_id', value: String(stationheadId) },
    legacyId == null ? null : { type: 'legacy_track_id', value: String(legacyId) },
    legacyName ? { type: 'legacy_name', value: legacyName } : null,
  ]);
  if (!aliases.length) return null;

  let trackId = await findAlias(db, 'sh_track_aliases', 'track_id', aliases);
  const canonicalKey = `${aliases[0].type}:${aliases[0].value}`;
  if (trackId == null) {
    await db.prepare(`INSERT OR IGNORE INTO sh_tracks(
      canonical_key,isrc,spotify_id,stationhead_track_id,title,artist,first_seen_at,last_seen_at
    ) VALUES(?,?,?,?,?,?,?,?)`).bind(
      canonicalKey, isrc, spotifyId, stationheadId, title, artist, observedAt, observedAt,
    ).run();
    const row = await db.prepare('SELECT id FROM sh_tracks WHERE canonical_key=?')
      .bind(canonicalKey).first();
    trackId = Number(row?.id);
  }
  if (!Number.isFinite(trackId)) return null;

  await db.prepare(`UPDATE sh_tracks SET
      isrc=COALESCE(isrc,?),spotify_id=COALESCE(spotify_id,?),
      stationhead_track_id=COALESCE(stationhead_track_id,?),
      title=COALESCE(title,?),artist=COALESCE(artist,?),
      last_seen_at=MAX(last_seen_at,?)
    WHERE id=?`).bind(
      isrc, spotifyId, stationheadId, title, artist, observedAt, trackId,
    ).run();
  await upsertAliases(db, 'sh_track_aliases', 'track_id', trackId, aliases, observedAt);
  return trackId;
}

async function sha256(value) {
  const input = new TextEncoder().encode(value);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (const byte of input) hash = Math.imul(hash ^ byte, 16777619);
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function queueStructurePayload(queue) {
  return {
    queue_id: integer(queue?.queue_id),
    start_time: timestampMs(queue?.start_time),
    tracks: (Array.isArray(queue?.tracks) ? queue.tracks : [])
      .map((track, fallbackPosition) => ({
        position: integer(track?.position) ?? fallbackPosition,
        queue_track_id: integer(track?.queue_track_id),
        stationhead_track_id: integer(track?.stationhead_track_id),
        isrc: normalizedIsrc(track?.isrc),
        spotify_id: text(track?.spotify_id),
        deezer_id: text(track?.deezer_id),
        duration_ms: integer(track?.duration_ms),
      }))
      .sort((left, right) => left.position - right.position),
  };
}

export async function queueStructuralHash(queue) {
  return sha256(JSON.stringify(queueStructurePayload(queue)));
}

async function endSession(db, sessionId, observedAt) {
  if (sessionId == null) return;
  await db.prepare(`UPDATE sh_broadcast_sessions SET
      last_observed_at=MAX(last_observed_at,?),ended_at=COALESCE(ended_at,?),status='ended'
    WHERE id=?`).bind(observedAt, observedAt, sessionId).run();
}

export async function resolveLiveSession(db, input) {
  const channelId = integer(input.channelId);
  if (channelId == null) throw new Error('minute facts require channel_id');
  const observedAt = integer(input.observedAt) ?? Date.now();
  const broadcasting = bool(input.isBroadcasting);
  const stationId = integer(input.stationId);
  const hostId = integer(input.hostId);
  const broadcastStart = timestampMs(input.broadcastStartTime);
  const active = await db.prepare(`SELECT * FROM sh_broadcast_sessions
    WHERE channel_id=? AND status='active' AND source='live_collector'
    ORDER BY last_observed_at DESC,id DESC LIMIT 1`).bind(channelId).first();

  if (broadcasting === 0) {
    await endSession(db, active?.id, observedAt);
    return null;
  }

  const same = active
    && (stationId == null || active.station_id == null || Number(active.station_id) === stationId)
    && (hostId == null || active.host_id == null || Number(active.host_id) === hostId)
    && (broadcastStart == null || active.broadcast_start_time == null
      || Number(active.broadcast_start_time) === broadcastStart)
    && observedAt - Number(active.last_observed_at || 0) <= SESSION_GAP_MS;
  if (same) {
    await db.prepare(`UPDATE sh_broadcast_sessions SET
        station_id=COALESCE(station_id,?),host_id=COALESCE(host_id,?),
        broadcast_start_time=COALESCE(broadcast_start_time,?),
        last_observed_at=MAX(last_observed_at,?)
      WHERE id=?`).bind(stationId, hostId, broadcastStart, observedAt, active.id).run();
    return Number(active.id);
  }

  await endSession(db, active?.id, observedAt);
  const sessionKey = `live:${channelId}:${broadcastStart ?? observedAt}:${hostId ?? 0}:${stationId ?? 0}`;
  await db.prepare(`INSERT OR IGNORE INTO sh_broadcast_sessions(
      session_key,channel_id,station_id,host_id,broadcast_start_time,
      first_observed_at,last_observed_at,ended_at,status,source
    ) VALUES(?,?,?,?,?,?,?,NULL,'active','live_collector')`).bind(
      sessionKey, channelId, stationId, hostId, broadcastStart, observedAt, observedAt,
    ).run();
  const row = await db.prepare('SELECT id FROM sh_broadcast_sessions WHERE session_key=?')
    .bind(sessionKey).first();
  return row?.id == null ? null : Number(row.id);
}

async function loadTrackMetadata(oldDb, tracks) {
  if (!oldDb) return new Map();
  const ids = [...new Set((tracks || []).map((track) => text(track?.spotify_id)).filter(Boolean))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  try {
    const result = await oldDb.prepare(`SELECT spotify_id,title,artist FROM sh_track_metadata
      WHERE spotify_id IN (${placeholders})`).bind(...ids).all();
    return new Map((result.results || []).map((row) => [String(row.spotify_id), row]));
  } catch {
    return new Map();
  }
}

export async function batchRun(db, statements, chunkSize = 35) {
  for (let index = 0; index < statements.length; index += chunkSize) {
    await db.batch(statements.slice(index, index + chunkSize));
  }
}

export function scheduleQueueTracks(tracks) {
  let offset = 0;
  let scheduleValid = true;
  return tracks.map((track) => {
    const duration = integer(track.duration_ms);
    const validItem = scheduleValid && duration != null && duration > 0;
    const scheduled = { ...track, playbackOffset: scheduleValid ? offset : null, scheduleValid: validItem };
    if (validItem) offset += duration;
    else scheduleValid = false;
    return scheduled;
  });
}

export function queueRevisionItemStatement(db, revisionId, track, biteCount) {
  return db.prepare(`INSERT INTO sh_queue_revision_items(
      revision_id,position,track_id,queue_track_id,stationhead_track_id,isrc,spotify_id,
      deezer_id,duration_ms,playback_offset_ms,schedule_valid,bite_count
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(revision_id,position) DO UPDATE SET
      track_id=excluded.track_id,queue_track_id=excluded.queue_track_id,
      stationhead_track_id=excluded.stationhead_track_id,isrc=excluded.isrc,
      spotify_id=excluded.spotify_id,deezer_id=excluded.deezer_id,
      duration_ms=excluded.duration_ms,playback_offset_ms=excluded.playback_offset_ms,
      schedule_valid=excluded.schedule_valid,bite_count=excluded.bite_count`).bind(
    revisionId, track.position, track.trackId, track.queue_track_id, track.stationhead_track_id,
    track.isrc, track.spotify_id, track.deezer_id, track.duration_ms,
    track.playbackOffset, track.scheduleValid ? 1 : 0, biteCount,
  );
}

export function findScheduledPosition(items, elapsedMs) {
  const match = (items || []).find((item) => Number(item.schedule_valid) === 1
    && elapsedMs >= Number(item.playback_offset_ms)
    && elapsedMs < Number(item.playback_offset_ms) + Number(item.duration_ms));
  return match?.position == null ? null : Number(match.position);
}

async function createRevision(db, oldDb, input) {
  const { channelId, stationId, sessionId, queue, observedAt, receivedAt } = input;
  const payload = queueStructurePayload(queue);
  const structuralHash = await queueStructuralHash(queue);
  const current = await db.prepare(`SELECT p.*,r.structural_hash,r.session_id AS revision_session_id
    FROM sh_playback_current p LEFT JOIN sh_queue_revisions r ON r.id=p.revision_id
    WHERE p.channel_id=?`).bind(channelId).first();
  const queueStart = timestampMs(queue?.start_time);
  const sameRevision = current?.revision_id != null
    && current.structural_hash === structuralHash
    && Number(current.revision_session_id || 0) === Number(sessionId || 0)
    && Number(current.queue_start_time || 0) === Number(queueStart || 0);
  if (sameRevision) return { revisionId: Number(current.revision_id), created: false, current };

  const tracks = payload.tracks;
  await db.prepare(`INSERT OR IGNORE INTO sh_queue_revisions(
      session_id,channel_id,station_id,queue_id,queue_start_time,effective_at,received_at,
      structural_hash,item_count,status,source,source_priority
    ) VALUES(?,?,?,?,?,?,?,?,?,'pending','live_collector',100)`)
    .bind(
      sessionId, channelId, stationId, integer(queue?.queue_id), queueStart,
      observedAt, receivedAt, structuralHash, tracks.length,
    ).run();
  const revision = await db.prepare(`SELECT id,status FROM sh_queue_revisions
    WHERE channel_id=? AND effective_at=? AND structural_hash=?`)
    .bind(channelId, observedAt, structuralHash).first();
  const revisionId = Number(revision?.id);
  if (!Number.isFinite(revisionId)) throw new Error('failed to create queue revision');

  const metadata = await loadTrackMetadata(oldDb, tracks);
  const withTrackIds = [];
  for (const track of tracks) {
    const details = metadata.get(String(track.spotify_id || '')) || {};
    const trackId = await resolveTrack(db, { ...track, title: details.title, artist: details.artist }, observedAt);
    withTrackIds.push({ ...track, trackId });
  }
  const resolved = scheduleQueueTracks(withTrackIds);

  const byPosition = new Map((queue?.tracks || []).map((track, index) => [integer(track?.position) ?? index, track]));
  const statements = resolved.map((track) => queueRevisionItemStatement(
    db, revisionId, track, integer(byPosition.get(track.position)?.bite_count),
  ));
  await batchRun(db, statements);
  const count = await db.prepare('SELECT COUNT(*) AS item_count FROM sh_queue_revision_items WHERE revision_id=?')
    .bind(revisionId).first();
  if (Number(count?.item_count || 0) !== tracks.length) {
    await db.prepare("UPDATE sh_queue_revisions SET status='invalid' WHERE id=?")
      .bind(revisionId).run();
    throw new Error(`queue revision ${revisionId} item count mismatch`);
  }
  await db.prepare("UPDATE sh_queue_revisions SET status='complete' WHERE id=?").bind(revisionId).run();
  return { revisionId, created: revision?.status !== 'complete', current: null };
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
    currentPosition = findScheduledPosition(items.results || [], elapsed);
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
      channelId, sessionId, revisionId, queueStartTime, paused ? 1 : 0, pausedTotal,
      pauseStartedAt, observedAt, currentPosition,
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
  const sourceTrack = (queue?.tracks || []).find((track, index) => (integer(track?.position) ?? index) === position);
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
      observedAt, channelId, stationId, revisionId, trackId, position, biteCount,
    ).run();
  }
  await db.prepare(`UPDATE sh_queue_revision_items SET bite_count=?
    WHERE revision_id=? AND position=?`).bind(biteCount, revisionId, position).run();
  return biteCount;
}

export function qualityScore(flags) {
  let score = 1;
  if (flags & FACT_QUALITY_FLAGS.QUEUE_MISSING) score -= 0.2;
  if (flags & FACT_QUALITY_FLAGS.TRACK_UNKNOWN) score -= 0.3;
  if (flags & FACT_QUALITY_FLAGS.COMMENTS_DEGRADED) score -= 0.1;
  if (flags & FACT_QUALITY_FLAGS.STREAM_REJECTED) score -= 0.1;
  if (flags & FACT_QUALITY_FLAGS.DELAYED_PAYLOAD) score -= 0.1;
  return Math.max(0, Number(score.toFixed(2)));
}

const FACT_COLUMNS = [
  'channel_id','station_id','minute_at','observed_at','received_at','source_code','source_priority',
  'source_record_id','collector_id','broadcast_session_id','host_id','is_broadcasting',
  'broadcast_start_time','listener_count','online_member_count','total_member_count','guest_count',
  'reported_total_listens','reported_current_stream_count','validated_stream_count',
  'stream_count_rejected','queue_revision_id','queue_id','queue_start_time','is_paused',
  'queue_track_count','queue_available','track_id','queue_position','track_detection_code',
  'track_confidence','schedule_valid','track_bite_count','comment_count','comment_total',
  'comments_degraded','quality_score','quality_flags',
];

export function minuteFactStatement(db, fact) {
  const values = [
    fact.channel_id, fact.station_id, fact.minute_at, fact.observed_at, fact.received_at,
    fact.source_code, fact.source_priority, fact.source_record_id, fact.collector_id,
    fact.broadcast_session_id, fact.host_id, fact.is_broadcasting, fact.broadcast_start_time,
    fact.listener_count, fact.online_member_count, fact.total_member_count, fact.guest_count,
    fact.reported_total_listens, fact.reported_current_stream_count, fact.validated_stream_count,
    fact.stream_count_rejected, fact.queue_revision_id, fact.queue_id, fact.queue_start_time,
    fact.is_paused, fact.queue_track_count, fact.queue_available, fact.track_id,
    fact.queue_position, fact.track_detection_code, fact.track_confidence,
    fact.schedule_valid, fact.track_bite_count, fact.comment_count, fact.comment_total,
    fact.comments_degraded, fact.quality_score, fact.quality_flags,
  ];
  const assignments = FACT_COLUMNS.slice(1).map((column) => `${column}=excluded.${column}`).join(',');
  const placeholders = FACT_COLUMNS.map(() => '?').join(',');
  return db.prepare(`INSERT INTO sh_minute_facts(${FACT_COLUMNS.join(',')}) VALUES(${placeholders})
    ON CONFLICT(channel_id,minute_at) DO UPDATE SET ${assignments}
    WHERE excluded.source_priority>sh_minute_facts.source_priority
      OR (excluded.source_priority=sh_minute_facts.source_priority
        AND excluded.quality_score>sh_minute_facts.quality_score)
      OR (excluded.source_priority=sh_minute_facts.source_priority
        AND excluded.quality_score=sh_minute_facts.quality_score
        AND excluded.observed_at>=sh_minute_facts.observed_at)`).bind(...values);
}

export async function upsertMinuteFact(db, fact) {
  return minuteFactStatement(db, fact).run();
}

export async function saveLiveMinuteFact(env, input) {
  const db = env?.FACTS_DB;
  if (!db) return { skipped: true, reason: 'facts-db-binding-missing' };
  const snapshot = input.snapshot || {};
  const queue = input.queue || null;
  const observedAt = integer(input.observedAt) ?? Date.now();
  const receivedAt = Date.now();
  const channelId = integer(snapshot.channel_id);
  if (channelId == null) return { skipped: true, reason: 'channel-id-missing' };
  const stationId = integer(snapshot.station_id ?? queue?.station_id);
  const hostId = await resolveHost(db, {
    accountId: snapshot.host_account_id,
    handle: snapshot.host_handle,
  }, observedAt);
  const sessionId = await resolveLiveSession(db, {
    channelId,
    stationId,
    hostId,
    broadcastStartTime: snapshot.broadcast_start_time,
    isBroadcasting: snapshot.is_broadcasting,
    observedAt,
  });

  let revisionId = null;
  let playback = null;
  if (queue && Array.isArray(queue.tracks) && bool(snapshot.is_broadcasting) !== 0) {
    const revision = await createRevision(db, env.DB, {
      channelId,
      stationId,
      sessionId,
      queue,
      observedAt,
      receivedAt,
    });
    revisionId = revision.revisionId;
    playback = await updatePlaybackState(db, {
      channelId,
      sessionId,
      revisionId,
      queueStartTime: timestampMs(queue.start_time),
      observedAt,
      isPaused: queue.is_paused,
    });
  }

  const position = integer(playback?.current_position);
  const item = revisionId == null || position == null ? null : await db.prepare(`SELECT
      track_id,schedule_valid FROM sh_queue_revision_items WHERE revision_id=? AND position=?`)
    .bind(revisionId, position).first();
  const trackId = integer(item?.track_id);
  const biteCount = revisionId == null ? null : await writeCurrentBite(db, {
    channelId, stationId, revisionId, position, observedAt, queue,
  });

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
  await upsertMinuteFact(db, fact);
  return { skipped: false, fact, sessionId, revisionId };
}
