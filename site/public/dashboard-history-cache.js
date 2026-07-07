(() => {
  const buckets = new Map();
  const BUCKET_MS = 5 * 60_000;
  const WINDOW_MS = 24 * 60 * 60_000;

  function mergeRow(row, cutoff) {
    const observedAt = Number(row?.observed_at);
    if (!Number.isFinite(observedAt) || observedAt < cutoff) return false;
    const bucket = Math.floor(observedAt / BUCKET_MS) * BUCKET_MS;
    const previous = buckets.get(bucket);
    const previousVelocity = Number(previous?.comment_velocity);
    const nextVelocity = Number(row?.comment_velocity);
    const commentVelocity = Number.isFinite(previousVelocity) || Number.isFinite(nextVelocity)
      ? Math.max(Number.isFinite(previousVelocity) ? previousVelocity : 0, Number.isFinite(nextVelocity) ? nextVelocity : 0)
      : null;
    if (!previous || observedAt >= Number(previous.observed_at)) {
      buckets.set(bucket, { ...row, comment_velocity: commentVelocity });
      return true;
    }
    if (commentVelocity !== previous.comment_velocity) {
      buckets.set(bucket, { ...previous, comment_velocity: commentVelocity });
      return true;
    }
    return false;
  }

  function seed(rows, cutoff = Date.now() - WINDOW_MS) {
    buckets.clear();
    for (const row of Array.isArray(rows) ? rows : []) mergeRow(row, cutoff);
  }

  function merge(rows, delta, previousRows = []) {
    const cutoff = Date.now() - WINDOW_MS;
    const incoming = Array.isArray(rows) ? rows : [];
    let changed = false;

    if (!delta || !buckets.size) {
      buckets.clear();
      if (delta) {
        for (const row of previousRows) changed = mergeRow(row, cutoff) || changed;
      }
      for (const row of incoming) changed = mergeRow(row, cutoff) || changed;
      changed = true;
    } else {
      for (const row of incoming) changed = mergeRow(row, cutoff) || changed;
    }

    const cutoffBucket = Math.floor(cutoff / BUCKET_MS) * BUCKET_MS;
    for (const bucket of buckets.keys()) {
      if (bucket >= cutoffBucket) continue;
      buckets.delete(bucket);
      changed = true;
    }

    if (!changed) return { rows: previousRows, changed: false };
    return {
      rows: [...buckets.values()].sort((a, b) => Number(a.observed_at) - Number(b.observed_at)),
      changed: true,
    };
  }

  function hasRows() {
    return buckets.size > 0;
  }

  window.DashboardHistoryCache = { seed, merge, hasRows };
})();
