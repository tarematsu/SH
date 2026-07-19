import { integer } from './minute-facts-track-descriptor.js';

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = integer(value);
  if (parsed == null || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function text(value) {
  const parsed = String(value ?? '').trim();
  return parsed || null;
}

export async function pendingSparseRevisionTasks(env, options = {}) {
  const db = env?.MINUTE_DB;
  if (!db?.prepare) return [];
  const limit = positiveInteger(options.limit, 1, 5);
  const now = integer(options.now) ?? Date.now();
  const staleMs = positiveInteger(
    options.staleMs ?? env?.DERIVE_REVISION_RECOVERY_STALE_MS,
    2 * 60_000,
    60 * 60_000,
  );
  const result = await db.prepare(`SELECT
      r.id AS revision_id,r.source_job_id,r.source_visible_count,r.item_count,
      r.materialized_item_count,
      r.channel_id,r.station_id,r.session_id,r.queue_id,r.queue_start_time,r.structural_hash,
      j.minute_at,j.observed_at,j.payload_version,j.job_kind,j.attempts,
      json_extract(j.payload_json,'$.snapshot.host_account_id') AS host_account_id,
      json_extract(j.payload_json,'$.snapshot.host_handle') AS host_handle,
      json_extract(j.payload_json,'$.snapshot.broadcast_start_time') AS broadcast_start_time,
      json_extract(j.payload_json,'$.snapshot.is_broadcasting') AS is_broadcasting,
      json_extract(j.payload_json,'$.queue.is_paused') AS is_paused
    FROM sh_queue_revisions r
    JOIN sh_minute_fact_jobs j ON j.id=r.source_job_id
    WHERE r.source_job_id IS NOT NULL
      AND COALESCE(r.coverage_complete,0)=0
      AND COALESCE(r.source_visible_count,0)>COALESCE(r.materialized_item_count,0)
      AND r.effective_at<=?
      AND COALESCE(r.last_materialized_at,r.effective_at)<=?
    ORDER BY COALESCE(r.last_materialized_at,r.effective_at) ASC,r.id ASC
    LIMIT ?`)
    .bind(now - staleMs, now - staleMs, limit)
    .all();

  return (result.results || []).map((row) => {
    const revisionId = integer(row.revision_id);
    const sourceJobId = integer(row.source_job_id);
    const visibleItemCount = Math.max(0, integer(row.source_visible_count) ?? 0);
    const totalItemCount = Math.max(visibleItemCount, integer(row.item_count) ?? visibleItemCount);
    const materializedItemCount = Math.max(
      0,
      Math.min(visibleItemCount, integer(row.materialized_item_count) ?? 0),
    );
    const jobKind = text(row.job_kind) || 'live';
    return {
      message_type: 'minute-fact-derive-stage',
      message_version: 1,
      stage: 'revision-materialize',
      job: {
        id: sourceJobId,
        channel_id: integer(row.channel_id),
        minute_at: integer(row.minute_at),
        payload_version: integer(row.payload_version) ?? 1,
        job_kind: jobKind,
        attempts: Math.max(1, integer(row.attempts) ?? 1),
      },
      revision: {
        sparse: true,
        rebuild: jobKind === 'rebuild',
        revision_id: revisionId,
        source_job_id: sourceJobId,
        visible_item_count: visibleItemCount,
        total_item_count: totalItemCount,
        preferred_position: materializedItemCount,
        materialized_item_count: materializedItemCount,
        enrichment: {
          channel_id: integer(row.channel_id),
          minute_at: integer(row.minute_at),
          observed_at: integer(row.observed_at),
          station_id: integer(row.station_id),
          provisional_session_id: integer(row.session_id),
          queue_start_time: integer(row.queue_start_time),
          is_paused: Number(row.is_paused || 0) === 1,
          host_account_id: integer(row.host_account_id),
          host_handle: text(row.host_handle),
          broadcast_start_time: integer(row.broadcast_start_time),
          is_broadcasting: row.is_broadcasting,
        },
        queue_identity: {
          station_id: integer(row.station_id),
          queue_id: integer(row.queue_id),
          start_time: integer(row.queue_start_time),
          total_track_count: totalItemCount,
          source_structural_hash: text(row.structural_hash),
        },
      },
      started_at: integer(row.observed_at) ?? now,
    };
  }).filter((task) => task.job.id != null && task.revision.revision_id != null);
}

export async function markSparseRevisionRecoveryDispatched(env, revisionIds, now = Date.now()) {
  const db = env?.MINUTE_DB;
  const ids = (Array.isArray(revisionIds) ? revisionIds : [])
    .map((value) => integer(value))
    .filter((value) => value != null);
  if (!db?.prepare || !ids.length) return { marked: 0 };
  const placeholders = ids.map(() => '?').join(',');
  const result = await db.prepare(`UPDATE sh_queue_revisions
    SET last_materialized_at=?
    WHERE id IN (${placeholders}) AND COALESCE(coverage_complete,0)=0`)
    .bind(integer(now) ?? Date.now(), ...ids)
    .run();
  return { marked: Number(result?.meta?.changes || 0) };
}
