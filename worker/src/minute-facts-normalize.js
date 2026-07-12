function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function integer(value) {
  const parsed = num(value);
  return parsed == null ? null : Math.trunc(parsed);
}

export function reportedStreamCount(value) {
  const parsed = integer(value);
  return parsed != null && parsed >= 0 ? parsed : null;
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

const MINUTE_MS = 60_000;

export function minuteBucket(timestamp) {
  return Math.floor(Number(timestamp) / MINUTE_MS) * MINUTE_MS;
}

export function timestampMs(value) {
  const parsed = num(value);
  if (parsed == null) return null;
  return Math.abs(parsed) < 100_000_000_000 ? Math.trunc(parsed * 1000) : Math.trunc(parsed);
}

export function normalizedHandle(value) {
  return text(value)?.toLowerCase() || null;
}

export function normalizedIsrc(value) {
  return text(value)?.toUpperCase() || null;
}

export function normalizedLegacyTrack(title, artist) {
  const titleKey = text(title)?.toLowerCase() || '';
  const artistKey = text(artist)?.toLowerCase() || '';
  return titleKey || artistKey ? `${titleKey}${artistKey}` : null;
}

export function uniqueAliases(aliases) {
  const seen = new Set();
  return aliases.filter((alias) => {
    if (!alias?.type || !alias?.value) return false;
    const key = `${alias.type}:${alias.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  'channel_id', 'station_id', 'minute_at', 'observed_at', 'received_at', 'source_code', 'source_priority',
  'source_record_id', 'collector_id', 'broadcast_session_id', 'host_id', 'is_broadcasting',
  'broadcast_start_time', 'listener_count', 'online_member_count', 'total_member_count', 'guest_count',
  'reported_total_listens', 'reported_current_stream_count', 'validated_stream_count',
  'stream_count_rejected', 'queue_revision_id', 'queue_id', 'queue_start_time', 'is_paused',
  'queue_track_count', 'queue_available', 'track_id', 'queue_position', 'track_detection_code',
  'track_confidence', 'schedule_valid', 'track_bite_count', 'comment_count', 'comment_total',
  'comments_degraded', 'quality_score', 'quality_flags',
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
