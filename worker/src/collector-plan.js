function enabled(value) {
  return value !== false && value !== null && value !== undefined;
}

export function buildCollectionPlan({ state = null, queue = null, queueResult = null } = {}) {
  const queueEnabled = Boolean(queue);
  return Object.freeze({
    snapshot: true,
    queue: queueEnabled,
    comments: Boolean(state?.stationId),
    metadata: queueEnabled && queueResult?.structure_changed === true,
    heartbeat: false,
  });
}

export function plannedStep(plan, name) {
  return enabled(plan?.[name]);
}
