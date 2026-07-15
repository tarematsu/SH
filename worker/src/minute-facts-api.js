export const LATEST_MINUTE_FACTS_PATH = '/api/minute-facts/latest';
export const LATEST_MINUTE_FACTS_LIMIT = 5;
export const DEFAULT_MINUTE_FACT_STALE_MS = 5 * 60_000;
export const EXPECTED_MINUTE_FACT_INTERVAL_MS = 2 * 60_000;

const SOURCE_NAMES = Object.freeze({
  1: 'live_collector',
  2: 'live_reconstructed',
  3: 'legacy_normalized',
  4: 'legacy_raw',
});

const COLLECTOR_NAMES = Object.freeze({
  1: 'cloudflare-worker',
  2: 'cloudflare-worker:rebuild',
  3: 'legacy-migration',
});

const TRACK_DETECTION_NAMES = Object.freeze({
  0: 'unknown',
  1: 'queue_inferred',
  2: 'queue_reconstructed',
});

const LATEST_MINUTE_FACTS_SQL = `SELECT
  f.id,
  f.channel_id,
  f.minute_at,
  f.observed_at,
  f.received_at,
  f.source_code,
  f.source_priority,
  f.source_record_id,
  f.collector_code,
  f.broadcast_session_id,
  f.is_broadcasting,
  f.listener_count,
  f.online_member_count,
  f.total_member_count,
  f.guest_count,
  f.reported_total_listens,
  f.reported_current_stream_count,
  f.is_paused,
  f.track_detection_code,
  f.track_confidence_code,
  f.schedule_valid,
  f.comment_count,
  f.comment_total,
  f.comments_degraded,
  f.quality_score_code,
  f.quality_flags
FROM sh_minute_facts f
ORDER BY f.minute_at DESC, f.id DESC
LIMIT 5`;

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function positiveInteger(value, fallback) {
  const parsed = integer(value);
  return parsed != null && parsed > 0 ? parsed : fallback;
}

function isoTimestamp(value) {
  const timestamp = integer(value);
  if (timestamp == null) return null;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return null;
  }
}

function boundedAge(now, value) {
  const timestamp = integer(value);
  return timestamp == null ? null : Math.max(0, now - timestamp);
}

function normalizeMinuteFact(row = {}) {
  const sourceCode = integer(row.source_code);
  const collectorCode = integer(row.collector_code);
  const trackDetectionCode = integer(row.track_detection_code);
  const trackConfidenceCode = integer(row.track_confidence_code);
  const qualityScoreCode = integer(row.quality_score_code);
  return {
    ...row,
    source: SOURCE_NAMES[sourceCode] || 'unknown',
    collector_id: COLLECTOR_NAMES[collectorCode] || null,
    track_detection_method: TRACK_DETECTION_NAMES[trackDetectionCode] || 'unknown',
    track_confidence: trackConfidenceCode == null ? null : trackConfidenceCode / 100,
    quality_score: qualityScoreCode == null ? null : qualityScoreCode / 100,
    minute_at_iso: isoTimestamp(row.minute_at),
    observed_at_iso: isoTimestamp(row.observed_at),
    received_at_iso: isoTimestamp(row.received_at),
  };
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

export async function readLatestMinuteFacts(env) {
  if (!env?.MINUTE_DB) throw new Error('MINUTE_DB binding is missing');
  const result = await env.MINUTE_DB.prepare(LATEST_MINUTE_FACTS_SQL).all();
  return (result?.results || []).slice(0, LATEST_MINUTE_FACTS_LIMIT);
}

export function buildLatestMinuteFactsPayload(rows = [], options = {}) {
  const now = integer(options.now) ?? Date.now();
  const staleAfterMs = positiveInteger(options.staleAfterMs, DEFAULT_MINUTE_FACT_STALE_MS);
  const facts = rows.slice(0, LATEST_MINUTE_FACTS_LIMIT).map(normalizeMinuteFact);
  const latest = facts[0] || null;
  const latestAgeMs = boundedAge(now, latest?.minute_at);
  const latestReceivedAgeMs = boundedAge(now, latest?.received_at);
  const stale = !latest || latestAgeMs == null || latestAgeMs > staleAfterMs;
  return {
    ok: !stale,
    query_ok: true,
    stale,
    reason: !latest ? 'no-minute-facts' : stale ? 'latest-minute-fact-stale' : null,
    generated_at: now,
    generated_at_iso: isoTimestamp(now),
    expected_interval_ms: EXPECTED_MINUTE_FACT_INTERVAL_MS,
    stale_after_ms: staleAfterMs,
    latest_minute_at: latest?.minute_at ?? null,
    latest_minute_at_iso: latest?.minute_at_iso ?? null,
    latest_age_ms: latestAgeMs,
    latest_received_at: latest?.received_at ?? null,
    latest_received_at_iso: latest?.received_at_iso ?? null,
    latest_received_age_ms: latestReceivedAgeMs,
    count: facts.length,
    limit: LATEST_MINUTE_FACTS_LIMIT,
    rows: facts,
  };
}

export async function latestMinuteFactsResponse(request, env, dependencies = {}) {
  if (request.method !== 'GET') {
    return jsonResponse({ ok: false, error: 'method-not-allowed' }, 405, { allow: 'GET' });
  }
  const now = dependencies.now?.() ?? Date.now();
  try {
    const rows = await (dependencies.readLatestMinuteFacts || readLatestMinuteFacts)(env);
    const payload = buildLatestMinuteFactsPayload(rows, {
      now,
      staleAfterMs: env?.MINUTE_FACT_API_STALE_MS,
    });
    return jsonResponse(payload, payload.ok ? 200 : 503);
  } catch (error) {
    return jsonResponse({
      ok: false,
      query_ok: false,
      stale: true,
      reason: 'minute-facts-query-failed',
      generated_at: now,
      generated_at_iso: isoTimestamp(now),
      error: String(error?.message || error).replace(/\s+/g, ' ').trim().slice(0, 500),
      count: 0,
      limit: LATEST_MINUTE_FACTS_LIMIT,
      rows: [],
    }, 503);
  }
}
