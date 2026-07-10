const checkpointRaw = JSON.stringify({ checkpoint: true });

export const QUEUE_REACHABILITY_CHECKPOINT_MS = 2 * 60_000;

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boolOrNull(value) {
  if (value == null) return null;
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  return null;
}

export function queueReachabilityStatement(db, observedAt, data) {
  const stationId = numberOrNull(data?.station_id);
  const queueId = numberOrNull(data?.queue_id);
  const startTime = numberOrNull(data?.start_time);
  const paused = boolOrNull(data?.is_paused);
  const observed = numberOrNull(observedAt);
  return db.prepare(`INSERT INTO sh_queue_snapshots (
      observed_at,station_id,queue_id,start_time,is_paused,raw_json
    )
    SELECT ?,?,?,?,?,?
    WHERE ? IS NOT NULL AND ? IS NOT NULL AND ? IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM sh_queue_snapshots latest
        WHERE latest.id=(
          SELECT prior.id
          FROM sh_queue_snapshots prior
          WHERE prior.station_id IS ? AND prior.start_time IS ?
            AND prior.observed_at<=?
          ORDER BY prior.observed_at DESC,prior.id DESC
          LIMIT 1
        )
          AND latest.observed_at>?
          AND COALESCE(latest.is_paused,0)=COALESCE(?,0)
      )`).bind(
    observed, stationId, queueId, startTime, paused, checkpointRaw,
    observed, stationId, startTime,
    stationId, startTime,
    observed,
    observed == null ? null : observed - QUEUE_REACHABILITY_CHECKPOINT_MS,
    paused,
  );
}

export async function saveQueueReachability(db, observedAt, data) {
  const result = await queueReachabilityStatement(db, observedAt, data).run();
  return { inserted: Number(result?.meta?.changes || 0) > 0 };
}
