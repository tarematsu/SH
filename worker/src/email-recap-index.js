import app from './official-news-index.js';
import { runCloudHostMonitor } from './cloud-host-monitor.js';

const PATH = '/ingest/email-recap';
const LEASE_PATH = '/coordination/lease';
const DEFAULT_OFFSET_MINUTES = 57;
const LEASE_SCOPE = 'stationhead-primary';
const LEASE_TTL_MS = 180000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function authorized(request, env) {
  const expected = String(env.EMAIL_RECAP_SECRET || '').trim();
  const supplied = request.headers.get('authorization') || '';
  return Boolean(expected) && supplied === `Bearer ${expected}`;
}

function jstDate(timestamp) {
  return new Date(timestamp + 9 * 3600000).toISOString().slice(0, 10);
}

function addDays(dateText, days) {
  const timestamp = Date.parse(`${dateText}T00:00:00+09:00`);
  return jstDate(timestamp + days * 86400000);
}

function weeksBetween(a, b) {
  const start = Date.parse(`${a}T00:00:00Z`);
  const end = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 1;
  return Math.max(1, Math.round((end - start) / (7 * 86400000)));
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function renewCloudLease(env) {
  if (!env.DB) return null;
  const now = Date.now();
  const leaseUntil = now + LEASE_TTL_MS;
  try {
    await env.DB.prepare(`INSERT INTO sh_collector_leases (
        scope,holder_id,holder_kind,priority,lease_until,heartbeat_at,updated_at,metadata_json
      ) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(scope) DO UPDATE SET
        holder_id=excluded.holder_id,holder_kind=excluded.holder_kind,
        priority=excluded.priority,lease_until=excluded.lease_until,
        heartbeat_at=excluded.heartbeat_at,updated_at=excluded.updated_at,
        metadata_json=excluded.metadata_json`)
      .bind(
        LEASE_SCOPE,
        'cloudflare-worker',
        'cloud',
        100,
        leaseUntil,
        now,
        now,
        JSON.stringify({ cron: 'every-minute', ttl_ms: LEASE_TTL_MS }),
      ).run();
    return { leaseUntil, heartbeatAt: now };
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) return null;
    throw error;
  }
}

async function readCloudLease(env) {
  if (!env.DB) return null;
  try {
    return env.DB.prepare(`SELECT scope,holder_id,holder_kind,priority,
      lease_until,heartbeat_at,updated_at FROM sh_collector_leases WHERE scope=?`)
      .bind(LEASE_SCOPE).first();
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) return null;
    throw error;
  }
}

async function coordination(env) {
  const row = await readCloudLease(env);
  const now = Date.now();
  return json({
    ok: true,
    scope: LEASE_SCOPE,
    healthy: Boolean(row && Number(row.lease_until || 0) > now && row.holder_kind === 'cloud'),
    holder_id: row?.holder_id || null,
    holder_kind: row?.holder_kind || null,
    priority: finite(row?.priority),
    lease_until: finite(row?.lease_until),
    heartbeat_at: finite(row?.heartbeat_at),
    server_time: now,
    setup_required: !row,
  });
}

async function loadReferencePoints(env, effectiveAt) {
  const center = jstDate(effectiveAt);
  const from = addDays(center, -3);
  const to = addDays(center, 3);
  const result = await env.DB.prepare(`
    SELECT period_key,period_start,period_end,stream_start,stream_end
    FROM sh_daily_summary
    WHERE period_key>=? AND period_key<=?
    ORDER BY period_key ASC
  `).bind(from, to).all();

  const points = [];
  for (const row of result.results || []) {
    const startAt = finite(row.period_start);
    const startCount = finite(row.stream_start);
    const endAt = finite(row.period_end);
    const endCount = finite(row.stream_end);
    if (startAt != null && startCount != null) points.push({ at: startAt, count: startCount, source: 'daily_start' });
    if (endAt != null && endCount != null) points.push({ at: endAt, count: endCount, source: 'daily_end' });
  }
  points.sort((a, b) => a.at - b.at);
  return points;
}

function assess(points, effectiveAt, streamCount) {
  let previous = null;
  let next = null;
  for (const point of points) {
    if (point.at <= effectiveAt) previous = point;
    if (point.at >= effectiveAt) {
      next = point;
      break;
    }
  }

  let estimated = null;
  if (previous && next && next.at > previous.at) {
    const ratio = (effectiveAt - previous.at) / (next.at - previous.at);
    estimated = Math.round(previous.count + (next.count - previous.count) * ratio);
  } else if (previous) estimated = previous.count;
  else if (next) estimated = next.count;

  let nearest = null;
  if (previous && (!next || Math.abs(effectiveAt - previous.at) <= Math.abs(next.at - effectiveAt))) nearest = previous;
  else nearest = next;

  const difference = estimated == null ? null : streamCount - estimated;
  const relativeDifference = estimated == null || streamCount <= 0
    ? null
    : Math.abs(difference) / streamCount;
  const distanceMinutes = nearest ? Math.abs(nearest.at - effectiveAt) / 60000 : null;

  let status;
  let accepted;
  if (estimated == null || distanceMinutes == null || distanceMinutes > 1440) {
    status = 'unverified_reference_gap';
    accepted = true;
  } else if (Math.abs(difference) <= 1000) {
    status = 'validated_excellent';
    accepted = true;
  } else if (Math.abs(difference) <= 10000) {
    status = 'validated_good';
    accepted = true;
  } else if (Math.abs(difference) <= 50000 && relativeDifference <= 0.001) {
    status = 'validated_plausible';
    accepted = true;
  } else {
    status = 'rejected_mismatch';
    accepted = false;
  }

  return {
    accepted,
    status,
    estimated,
    difference,
    relativeDifference,
    distanceMinutes,
    nearestSource: nearest?.source || null,
    previous,
    next,
  };
}

export const EMAIL_SERIES_CONTEXT_SQL = `WITH existing AS (
  SELECT source_key,week_of,stream_count
  FROM sh_email_stream_snapshots
  WHERE source_key=?
), previous AS (
  SELECT source_key,week_of,stream_count
  FROM sh_email_stream_snapshots
  WHERE week_of<?
  ORDER BY week_of DESC
  LIMIT 9
), following AS (
  SELECT source_key,week_of,stream_count
  FROM sh_email_stream_snapshots
  WHERE week_of>?
  ORDER BY week_of ASC
  LIMIT 1
)
SELECT 0 AS result_kind,source_key,week_of,stream_count FROM existing
UNION ALL
SELECT 1 AS result_kind,source_key,week_of,stream_count FROM previous
UNION ALL
SELECT 2 AS result_kind,source_key,week_of,stream_count FROM following
ORDER BY result_kind ASC,week_of ASC`;

export const EMAIL_RECAP_UPSERT_SQL = `
  INSERT INTO sh_email_stream_snapshots (
    source_key,week_of,email_sent_at,effective_at,stream_count,source,
    validation_status,timing_basis,timing_offset_minutes,reference_source,
    estimated_stream_count,difference,relative_difference,nearest_distance_minutes,
    validation_notes,imported_at
  ) VALUES (?,?,?,?,?,'stationhead_email_recap',?,'email_sent_minus_offset',?,?,?,?,?,?,?,?)
  ON CONFLICT(source_key) DO UPDATE SET
    email_sent_at=excluded.email_sent_at,
    effective_at=excluded.effective_at,
    stream_count=excluded.stream_count,
    validation_status=excluded.validation_status,
    timing_basis=excluded.timing_basis,
    timing_offset_minutes=excluded.timing_offset_minutes,
    reference_source=excluded.reference_source,
    estimated_stream_count=excluded.estimated_stream_count,
    difference=excluded.difference,
    relative_difference=excluded.relative_difference,
    nearest_distance_minutes=excluded.nearest_distance_minutes,
    validation_notes=excluded.validation_notes,
    imported_at=excluded.imported_at
  WHERE sh_email_stream_snapshots.email_sent_at IS NOT excluded.email_sent_at
     OR sh_email_stream_snapshots.effective_at IS NOT excluded.effective_at
     OR sh_email_stream_snapshots.stream_count IS NOT excluded.stream_count
     OR sh_email_stream_snapshots.validation_status IS NOT excluded.validation_status
     OR sh_email_stream_snapshots.timing_offset_minutes IS NOT excluded.timing_offset_minutes
     OR sh_email_stream_snapshots.reference_source IS NOT excluded.reference_source
     OR sh_email_stream_snapshots.estimated_stream_count IS NOT excluded.estimated_stream_count
     OR sh_email_stream_snapshots.difference IS NOT excluded.difference
     OR sh_email_stream_snapshots.relative_difference IS NOT excluded.relative_difference
     OR sh_email_stream_snapshots.nearest_distance_minutes IS NOT excluded.nearest_distance_minutes
     OR sh_email_stream_snapshots.validation_notes IS NOT excluded.validation_notes`;

export async function loadEmailSeriesContext(db, sourceKey, weekOf) {
  const result = await db.prepare(EMAIL_SERIES_CONTEXT_SQL).bind(sourceKey, weekOf, weekOf).all();
  let existing = null;
  let next = null;
  const previousRows = [];
  for (const row of result.results || []) {
    const kind = Number(row.result_kind);
    const value = { source_key: row.source_key, week_of: row.week_of, stream_count: row.stream_count };
    if (kind === 0) existing = value;
    else if (kind === 1) previousRows.push(value);
    else if (kind === 2) next = value;
  }
  return { existing, previousRows, next };
}

export async function assessEmailSeries(env, sourceKey, weekOf, streamCount) {
  const { existing, previousRows, next } = await loadEmailSeriesContext(env.DB, sourceKey, weekOf);
  if (existing && Number(existing.stream_count) !== streamCount) {
    return {
      accepted: false,
      status: 'rejected_existing_week_changed',
      reason: `existing=${existing.stream_count}, incoming=${streamCount}`,
    };
  }

  const previous = previousRows.at(-1) || null;

  if (previous && streamCount < Number(previous.stream_count)) {
    return { accepted: false, status: 'rejected_non_monotonic', reason: 'below previous week' };
  }
  if (next && streamCount > Number(next.stream_count)) {
    return { accepted: false, status: 'rejected_non_monotonic', reason: 'above next week' };
  }

  const historicalRates = [];
  for (let index = 1; index < previousRows.length; index += 1) {
    const before = previousRows[index - 1];
    const after = previousRows[index];
    const delta = Number(after.stream_count) - Number(before.stream_count);
    if (delta >= 0) historicalRates.push(delta / weeksBetween(before.week_of, after.week_of));
  }
  const typicalWeeklyGrowth = median(historicalRates);
  let incomingWeeklyGrowth = null;
  if (previous) {
    incomingWeeklyGrowth = (streamCount - Number(previous.stream_count)) / weeksBetween(previous.week_of, weekOf);
  }

  if (
    typicalWeeklyGrowth != null
    && incomingWeeklyGrowth != null
    && incomingWeeklyGrowth > typicalWeeklyGrowth * 3
    && incomingWeeklyGrowth - typicalWeeklyGrowth > 200000
  ) {
    return {
      accepted: false,
      status: 'rejected_growth_anomaly',
      reason: `incoming_per_week=${Math.round(incomingWeeklyGrowth)}, median=${Math.round(typicalWeeklyGrowth)}`,
      typicalWeeklyGrowth,
      incomingWeeklyGrowth,
    };
  }

  return {
    accepted: true,
    status: existing ? 'existing_match' : 'series_plausible',
    previous,
    next,
    typicalWeeklyGrowth,
    incomingWeeklyGrowth,
  };
}

async function ingest(request, env) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);
  if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }

  const weekOf = String(body.week_of || '').trim();
  const emailSentAt = finite(body.email_sent_at);
  const streamCount = finite(body.stream_count);
  const messageId = String(body.message_id || '').trim().slice(0, 200);
  const subject = String(body.subject || '').trim().slice(0, 500);
  const offsetMinutes = Math.round(finite(body.timing_offset_minutes) ?? DEFAULT_OFFSET_MINUTES);

  if (!validDate(weekOf)) return json({ ok: false, error: 'invalid week_of' }, 400);
  if (!emailSentAt || emailSentAt < 1700000000000) return json({ ok: false, error: 'invalid email_sent_at' }, 400);
  if (!streamCount || streamCount < 1) return json({ ok: false, error: 'invalid stream_count' }, 400);
  if (offsetMinutes < 0 || offsetMinutes > 180) return json({ ok: false, error: 'invalid timing_offset_minutes' }, 400);

  const sourceKey = `stationhead-email:${weekOf}`;
  const effectiveAt = emailSentAt - offsetMinutes * 60000;
  const [points, seriesValidation] = await Promise.all([
    loadReferencePoints(env, effectiveAt),
    assessEmailSeries(env, sourceKey, weekOf, streamCount),
  ]);
  const validation = assess(points, effectiveAt, streamCount);

  if (!seriesValidation.accepted || !validation.accepted) {
    return json({
      ok: false,
      imported: false,
      source_key: sourceKey,
      validation_status: !seriesValidation.accepted ? seriesValidation.status : validation.status,
      validation_reason: !seriesValidation.accepted ? seriesValidation.reason : null,
      stream_count: streamCount,
      estimated_stream_count: validation.estimated,
      difference: validation.difference,
      relative_difference: validation.relativeDifference,
      nearest_distance_minutes: validation.distanceMinutes,
      series_validation: seriesValidation,
    }, 409);
  }

  const notes = JSON.stringify({
    message_id: messageId || null,
    subject: subject || null,
    previous: validation.previous,
    next: validation.next,
    series_validation: seriesValidation,
  });
  const importedAt = Date.now();

  const writeResult = await env.DB.prepare(EMAIL_RECAP_UPSERT_SQL).bind(
    sourceKey,
    weekOf,
    emailSentAt,
    effectiveAt,
    streamCount,
    validation.status,
    offsetMinutes,
    validation.nearestSource,
    validation.estimated,
    validation.difference,
    validation.relativeDifference,
    validation.distanceMinutes,
    notes,
    importedAt,
  ).run();
  const changed = Number(writeResult?.meta?.changes ?? 1);

  return json({
    ok: true,
    imported: changed > 0,
    unchanged: changed === 0,
    source_key: sourceKey,
    week_of: weekOf,
    email_sent_at: emailSentAt,
    effective_at: effectiveAt,
    stream_count: streamCount,
    validation_status: validation.status,
    estimated_stream_count: validation.estimated,
    difference: validation.difference,
    relative_difference: validation.relativeDifference,
    nearest_distance_minutes: validation.distanceMinutes,
    series_validation: seriesValidation.status,
  });
}

async function enhancedHealth(request, env, ctx) {
  const response = await app.fetch(request, env, ctx);
  const base = await response.json().catch(() => ({}));
  let lease = null;
  let hostMonitor = null;
  try {
    lease = await readCloudLease(env);
    hostMonitor = await env.DB.prepare(`SELECT phase,session_id,station_id,last_success_at,last_error,updated_at
      FROM sh_cloud_host_monitor_state WHERE id=?`).bind('solo:sakurazaka46jp').first();
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || ''))) console.error(error);
  }
  return json({
    ...base,
    collector_lease_until: finite(lease?.lease_until),
    collector_lease_healthy: Boolean(lease && Number(lease.lease_until) > Date.now()),
    cloud_solo_phase: hostMonitor?.phase || null,
    cloud_solo_session_id: finite(hostMonitor?.session_id),
    cloud_solo_station_id: finite(hostMonitor?.station_id),
    cloud_host_last_success_at: finite(hostMonitor?.last_success_at),
    cloud_host_last_error: hostMonitor?.last_error || null,
  }, response.status);
}

export default {
  async scheduled(controller, env, ctx) {
    await renewCloudLease(env).catch((error) => {
      console.error(JSON.stringify({ event: 'collector_lease_failed', error: String(error?.message || error) }));
    });
    await app.scheduled(controller, env, ctx);
    ctx.waitUntil(runCloudHostMonitor(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === LEASE_PATH) return coordination(env);
    if (request.method === 'POST' && url.pathname === PATH) return ingest(request, env);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return enhancedHealth(request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },
};
