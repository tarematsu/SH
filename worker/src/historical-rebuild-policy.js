function enabled(value, fallback = true) {
  if (value == null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

export function historicalRebuildEnabled(env = {}) {
  return enabled(env?.HISTORICAL_REBUILD_ENABLED, true);
}
