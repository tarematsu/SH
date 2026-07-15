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
      schedule_valid=excluded.schedule_valid`).bind(
    revisionId, track.position, track.trackId, track.queue_track_id, track.stationhead_track_id,
    track.isrc, track.spotify_id, track.deezer_id, track.duration_ms,
    track.playbackOffset, track.scheduleValid ? 1 : 0,
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

export function scoreCode(value, fallback = null) {
  const parsed = num(value);
  if (parsed == null) return fallback;
  return Math.max(0, Math.min(100, Math.round(parsed * 100)));
}

export function scoreFromCode(value, fallback = null) {
  const parsed = integer(value);
  return parsed == null ? fallback : parsed / 100;
}

export const MINUTE_FACT_COLLECTOR_CODES = Object.freeze({
  'cloudflare-worker': 1,
  'cloudflare-worker:rebuild': 2,
  'legacy-migration': 3,
});

export function minuteFactCollectorCode(value) {
  return MINUTE_FACT_COLLECTOR_CODES[text(value)] ?? 0;
}

export function minuteFactCollectorName(code) {
  const numericCode = integer(code);
  return Object.entries(MINUTE_FACT_COLLECTOR_CODES)
    .find(([, value]) => value === numericCode)?.[0] || null;
}

export async function ensureMinuteFactCollectorCode(db, value) {
  const collectorId = text(value) || 'cloudflare-worker';
  const knownCode = minuteFactCollectorCode(collectorId);
  if (knownCode) return knownCode;
  await db.prepare(`INSERT OR IGNORE INTO sh_minute_fact_collectors(collector_id)
    VALUES(?)`).bind(collectorId).run();
  const row = await db.prepare(`SELECT collector_code FROM sh_minute_fact_collectors
    WHERE collector_id=? LIMIT 1`).bind(collectorId).first();
  return integer(row?.collector_code) || 0;
}

const FACT_COLUMNS = [
  'channel_id', 'minute_at', 'observed_at', 'received_at', 'source_code', 'source_priority',
  'source_record_id', 'collector_code', 'broadcast_session_id', 'is_broadcasting',
  'listener_count', 'online_member_count', 'total_member_count', 'guest_count',
  'reported_total_listens', 'reported_current_stream_count', 'is_paused',
  'track_detection_code', 'track_confidence_code', 'schedule_valid', 'comment_count',
  'comment_total', 'comments_degraded', 'quality_score_code', 'quality_flags',
];

export function minuteFactStatement(db, fact) {
  const collectorCode = integer(fact.collector_code)
    ?? minuteFactCollectorCode(fact.collector_id);
  const trackConfidenceCode = integer(fact.track_confidence_code)
    ?? scoreCode(fact.track_confidence, 0);
  const qualityScoreCode = integer(fact.quality_score_code)
    ?? scoreCode(fact.quality_score, 100);
  const values = [
    fact.channel_id, fact.minute_at, fact.observed_at, fact.received_at,
    fact.source_code, fact.source_priority, fact.source_record_id, collectorCode,
    fact.broadcast_session_id, fact.is_broadcasting,
    fact.listener_count, fact.online_member_count,
    fact.store_total_member_count ? fact.total_member_count : null, fact.guest_count,
    fact.reported_total_listens, fact.reported_current_stream_count, fact.is_paused,
    fact.track_detection_code, trackConfidenceCode, fact.schedule_valid,
    fact.comment_count, fact.comment_total, fact.comments_degraded,
    qualityScoreCode, fact.quality_flags,
  ];
  const assignments = FACT_COLUMNS.slice(1).map((column) => `${column}=excluded.${column}`).join(',');
  const placeholders = FACT_COLUMNS.map(() => '?').join(',');
  return db.prepare(`INSERT INTO sh_minute_facts(${FACT_COLUMNS.join(',')}) VALUES(${placeholders})
    ON CONFLICT(channel_id,minute_at) DO UPDATE SET ${assignments}
    WHERE excluded.source_priority>sh_minute_facts.source_priority
      OR (excluded.source_priority=sh_minute_facts.source_priority
        AND excluded.quality_score_code>sh_minute_facts.quality_score_code)
      OR (excluded.source_priority=sh_minute_facts.source_priority
        AND excluded.quality_score_code=sh_minute_facts.quality_score_code
        AND excluded.observed_at>=sh_minute_facts.observed_at)`).bind(...values);
}

const CONTEXT_COLUMNS = [
  'queue_revision_id', 'queue_available', 'queue_position',
];

const WINNER_CONDITION = `
  ? > f.source_priority
  OR (? = f.source_priority AND ? > f.quality_score_code)
  OR (? = f.source_priority AND ? = f.quality_score_code AND ? >= f.observed_at)`;

function contextPresent(fact) {
  return fact.queue_revision_id != null
    || Number(fact.queue_available || 0) !== 0
    || fact.queue_position != null
    || fact.broadcast_session_id == null;
}

function compactScoreCode(fact) {
  return integer(fact.quality_score_code) ?? scoreCode(fact.quality_score, 100);
}

export function minuteFactContextUpsertStatement(db, fact) {
  const values = [
    fact.station_id, fact.station_id,
    fact.host_id, fact.host_id,
    fact.broadcast_start_time, fact.broadcast_start_time,
    fact.queue_revision_id, fact.queue_available, fact.queue_position,
  ];
  return db.prepare(`INSERT INTO sh_minute_fact_context_v2(
      fact_id,station_id_override,host_id_override,broadcast_start_time_override,
      queue_revision_id,queue_available,queue_position
    )
    SELECT f.id,
      CASE WHEN f.broadcast_session_id IS NULL OR ? IS NOT
        (SELECT station_id FROM sh_broadcast_sessions s WHERE s.id=f.broadcast_session_id)
        THEN ? END,
      CASE WHEN f.broadcast_session_id IS NULL OR ? IS NOT
        (SELECT host_id FROM sh_broadcast_sessions s WHERE s.id=f.broadcast_session_id)
        THEN ? END,
      CASE WHEN f.broadcast_session_id IS NULL OR ? IS NOT
        (SELECT broadcast_start_time FROM sh_broadcast_sessions s WHERE s.id=f.broadcast_session_id)
        THEN ? END,
      ?,?,?
    FROM sh_minute_facts f
    WHERE f.channel_id=? AND f.minute_at=?
      AND (${WINNER_CONDITION})
      AND (?=1)
    ON CONFLICT(fact_id) DO UPDATE SET
      ${CONTEXT_COLUMNS.map((column) => `${column}=excluded.${column}`).join(',')}`).bind(
    ...values,
    fact.channel_id,
    fact.minute_at,
    fact.source_priority,
    fact.source_priority,
    compactScoreCode(fact),
    fact.source_priority,
    compactScoreCode(fact),
    fact.observed_at,
    contextPresent(fact) ? 1 : 0,
  );
}

export function minuteFactContextDeleteStatement(db, fact) {
  return db.prepare(`DELETE FROM sh_minute_fact_context_v2
    WHERE fact_id=(
      SELECT f.id FROM sh_minute_facts f
      WHERE f.channel_id=? AND f.minute_at=?
        AND (${WINNER_CONDITION})
    )
    AND ?=0`).bind(
    fact.channel_id,
    fact.minute_at,
    fact.source_priority,
    fact.source_priority,
    compactScoreCode(fact),
    fact.source_priority,
    compactScoreCode(fact),
    fact.observed_at,
    contextPresent(fact) ? 1 : 0,
  );
}

export function totalMemberDailyStatement(db, fact) {
  const count = integer(fact.total_member_count);
  if (count == null || count < 0) return db.prepare('SELECT 1 WHERE 0');
  const observedAt = integer(fact.observed_at);
  const dayAt = Math.floor(observedAt / 86400000) * 86400000;
  const rawHostId = integer(fact.host_id);
  const hostId = rawHostId != null && rawHostId > 0 ? rawHostId : null;
  const hostKey = hostId ?? 0;
  return db.prepare(`INSERT INTO sh_total_member_daily(
      channel_id,day_at,host_key,host_id,first_observed_at,last_observed_at,
      first_total_member_count,last_total_member_count,min_total_member_count,
      max_total_member_count,source_code,source_priority,quality_score_code
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(channel_id,day_at,host_key) DO UPDATE SET
      first_observed_at=MIN(sh_total_member_daily.first_observed_at,excluded.first_observed_at),
      first_total_member_count=CASE WHEN excluded.first_observed_at<sh_total_member_daily.first_observed_at
        THEN excluded.first_total_member_count ELSE sh_total_member_daily.first_total_member_count END,
      last_observed_at=MAX(sh_total_member_daily.last_observed_at,excluded.last_observed_at),
      last_total_member_count=CASE WHEN excluded.last_observed_at>=sh_total_member_daily.last_observed_at
        THEN excluded.last_total_member_count ELSE sh_total_member_daily.last_total_member_count END,
      min_total_member_count=MIN(sh_total_member_daily.min_total_member_count,excluded.min_total_member_count),
      max_total_member_count=MAX(sh_total_member_daily.max_total_member_count,excluded.max_total_member_count),
      source_code=excluded.source_code,source_priority=excluded.source_priority,
      quality_score_code=excluded.quality_score_code
    WHERE excluded.first_observed_at<sh_total_member_daily.first_observed_at
      OR excluded.last_observed_at>sh_total_member_daily.last_observed_at
      OR (excluded.last_observed_at=sh_total_member_daily.last_observed_at
        AND (excluded.last_total_member_count IS NOT sh_total_member_daily.last_total_member_count
        OR excluded.source_priority>sh_total_member_daily.source_priority
        OR (excluded.source_priority=sh_total_member_daily.source_priority
          AND excluded.quality_score_code>sh_total_member_daily.quality_score_code)))`).bind(
    fact.channel_id, dayAt, hostKey, hostId, observedAt, observedAt,
    count, count, count, count, fact.source_code, fact.source_priority,
    compactScoreCode(fact),
  );
}

export function minuteFactStatements(db, fact) {
  return [
    minuteFactStatement(db, fact),
    totalMemberDailyStatement(db, fact),
    minuteFactContextUpsertStatement(db, fact),
    minuteFactContextDeleteStatement(db, fact),
  ];
}
