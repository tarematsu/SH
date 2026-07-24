import {
  integer,
  minuteFactCollectorCode,
  scoreCode,
} from './minute-facts-normalize.js';

const FACT_COLUMNS = [
  'channel_id', 'minute_at', 'observed_at', 'received_at', 'source_code', 'source_priority',
  'source_record_id', 'collector_code', 'broadcast_session_id', 'is_broadcasting',
  'listener_count', 'online_member_count', 'total_member_count', 'guest_count',
  'reported_total_listens', 'reported_current_stream_count', 'is_paused',
  'track_detection_code', 'track_confidence_code', 'schedule_valid', 'comment_count',
  'comment_total', 'comments_degraded', 'quality_score_code', 'quality_flags',
];

// Timestamps alone do not justify rewriting a row for the same natural minute.
// Priority and quality improvements are handled separately by the winner clauses.
const FACT_CHANGE_COLUMNS = FACT_COLUMNS.filter((column) => ![
  'channel_id',
  'minute_at',
  'observed_at',
  'received_at',
  'source_priority',
  'quality_score_code',
].includes(column));

function compactFactValues(fact) {
  const collectorCode = integer(fact.collector_code)
    ?? minuteFactCollectorCode(fact.collector_id);
  const trackConfidenceCode = integer(fact.track_confidence_code)
    ?? scoreCode(fact.track_confidence, 0);
  const qualityScoreCode = integer(fact.quality_score_code)
    ?? scoreCode(fact.quality_score, 100);
  return {
    values: [
      fact.channel_id, fact.minute_at, fact.observed_at, fact.received_at,
      fact.source_code, fact.source_priority, fact.source_record_id, collectorCode,
      fact.broadcast_session_id, fact.is_broadcasting,
      fact.listener_count, fact.online_member_count,
      fact.store_total_member_count ? fact.total_member_count : null, fact.guest_count,
      fact.reported_total_listens, fact.reported_current_stream_count, fact.is_paused,
      fact.track_detection_code, trackConfidenceCode, fact.schedule_valid,
      fact.comment_count, fact.comment_total, fact.comments_degraded,
      qualityScoreCode, fact.quality_flags,
    ],
    qualityScoreCode,
  };
}

export function guardedMinuteFactStatement(db, fact) {
  const { values } = compactFactValues(fact);
  const assignments = FACT_COLUMNS.slice(1)
    .map((column) => `${column}=excluded.${column}`)
    .join(',');
  const placeholders = FACT_COLUMNS.map(() => '?').join(',');
  const changed = FACT_CHANGE_COLUMNS
    .map((column) => `excluded.${column} IS NOT sh_minute_facts.${column}`)
    .join('\n          OR ');
  return db.prepare(`INSERT INTO sh_minute_facts(${FACT_COLUMNS.join(',')}) VALUES(${placeholders})
    ON CONFLICT(channel_id,minute_at) DO UPDATE SET ${assignments}
    WHERE excluded.source_priority>sh_minute_facts.source_priority
      OR (excluded.source_priority=sh_minute_facts.source_priority
        AND excluded.quality_score_code>sh_minute_facts.quality_score_code)
      OR (excluded.source_priority=sh_minute_facts.source_priority
        AND excluded.quality_score_code=sh_minute_facts.quality_score_code
        AND excluded.observed_at>=sh_minute_facts.observed_at
        AND (${changed}))`).bind(...values);
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

export function guardedMinuteFactContextUpsertStatement(db, fact) {
  const values = [
    fact.station_id, fact.station_id,
    fact.host_id, fact.host_id,
    fact.broadcast_start_time, fact.broadcast_start_time,
    fact.queue_revision_id, fact.queue_available, fact.queue_position,
  ];
  const changed = CONTEXT_COLUMNS
    .map((column) => `excluded.${column} IS NOT sh_minute_fact_context_v2.${column}`)
    .join('\n        OR ');
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
      ${CONTEXT_COLUMNS.map((column) => `${column}=excluded.${column}`).join(',')}
    WHERE ${changed}`).bind(
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
