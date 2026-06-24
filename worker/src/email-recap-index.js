import app from './official-news-index.js';

const PATH = '/ingest/email-recap';
const DEFAULT_OFFSET_MINUTES = 57;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
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
  const points = await loadReferencePoints(env, effectiveAt);
  const validation = assess(points, effectiveAt, streamCount);

  if (!validation.accepted) {
    return json({
      ok: false,
      imported: false,
      source_key: sourceKey,
      validation_status: validation.status,
      stream_count: streamCount,
      estimated_stream_count: validation.estimated,
      difference: validation.difference,
      relative_difference: validation.relativeDifference,
      nearest_distance_minutes: validation.distanceMinutes,
    }, 409);
  }

  const notes = JSON.stringify({
    message_id: messageId || null,
    subject: subject || null,
    previous: validation.previous,
    next: validation.next,
  });
  const importedAt = Date.now();

  await env.DB.prepare(`
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
  `).bind(
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

  return json({
    ok: true,
    imported: true,
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
  });
}

export default {
  scheduled(controller, env, ctx) {
    return app.scheduled(controller, env, ctx);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === PATH) return ingest(request, env);
    return app.fetch(request, env, ctx);
  },
};
