import {
  DEFAULT_EMAIL_RECAP_OFFSET_MINUTES,
  authorized,
  finite,
  json,
  validDate,
} from './email-recap-utils.js';
import {
  assess,
  assessEmailSeries,
  loadReferencePoints,
} from './email-recap-validation.js';

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

export async function ingestEmailRecap(request, env) {
  if (!env.DB || !env.OTHER_DB) return json({ ok: false, error: 'DB binding missing' }, 500);
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
  const offsetMinutes = Math.round(finite(body.timing_offset_minutes) ?? DEFAULT_EMAIL_RECAP_OFFSET_MINUTES);

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
