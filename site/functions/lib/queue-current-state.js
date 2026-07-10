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

export async function saveQueueCurrentPauseState(db, observedAt, data, now = Date.now()) {
  const stationId = numberOrNull(data?.station_id);
  const observed = numberOrNull(observedAt);
  const paused = boolOrNull(data?.is_paused);
  if (stationId == null || observed == null || paused == null) return { updated: false };

  const result = await db.prepare(`UPDATE sh_queue_current
    SET is_paused=?,observed_at=?,updated_at=?
    WHERE station_id IS ?
      AND observed_at<=?
      AND is_paused IS NOT ?`).bind(
    paused,
    observed,
    numberOrNull(now) ?? observed,
    stationId,
    observed,
    paused,
  ).run();
  return { updated: Number(result?.meta?.changes || 0) > 0 };
}
