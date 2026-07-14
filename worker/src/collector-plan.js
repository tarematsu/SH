const DEFAULT_METADATA_REFRESH_MS = 15 * 60_000;

function enabled(value) {
  return value !== false && value !== null && value !== undefined;
}

export function metadataRefreshDue(
  previousRunAt,
  observedAt,
  intervalMs = DEFAULT_METADATA_REFRESH_MS,
) {
  const previous = Number(previousRunAt || 0);
  const current = Number(observedAt || 0);
  const interval = Math.max(60_000, Number(intervalMs) || DEFAULT_METADATA_REFRESH_MS);
  if (!Number.isFinite(current) || current <= 0) return false;
  if (!Number.isFinite(previous) || previous <= 0) return true;
  return Math.floor(previous / interval) !== Math.floor(current / interval);
}

export function buildCollectionPlan({
  state = null,
  queue = null,
  queueResult = null,
  previousRunAt = 0,
  observedAt = Date.now(),
  metadataRefreshIntervalMs = DEFAULT_METADATA_REFRESH_MS,
  metadataRetry = false,
} = {}) {
  const queueEnabled = Boolean(queue);
  const metadataDue = metadataRetry || metadataRefreshDue(
    previousRunAt,
    observedAt,
    metadataRefreshIntervalMs,
  );
  return Object.freeze({
    snapshot: true,
    queue: queueEnabled,
    comments: Boolean(state?.stationId),
    metadataDue,
    metadata: queueEnabled && (
      queueResult?.structure_changed === true
      || metadataDue
    ),
    heartbeat: false,
  });
}

export function plannedStep(plan, name) {
  return enabled(plan?.[name]);
}
