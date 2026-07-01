(() => {
  const DAY_MS = 86400000;
  const TOLERANCE_MS = 15 * 60 * 1000;
  const baseReadCache = readCache;
  const baseWriteCache = writeCache;
  const baseRenderWeeklyMetrics = renderWeeklyMetrics;

  function cacheKeyVersion(key) {
    return String(key || '')
      .replace(/^track-history:v11:/, 'track-history:v12:')
      .replace(/^history:v9:/, 'history:v10:');
  }

  readCache = function readCompletenessCache(key) {
    return baseReadCache(cacheKeyVersion(key));
  };

  writeCache = function writeCompletenessCache(key, data) {
    return baseWriteCache(cacheKeyVersion(key), data);
  };

  function rowIsComplete(row) {
    return row?.period_complete !== false && row?.play_count_excluded !== true;
  }

  withDailyTotals = function withValidatedDailyTotals(rows) {
    const values = Array.isArray(rows) ? rows : [];
    const stateByDate = new Map();
    for (const row of values) {
      const key = String(row?.play_date || '');
      if (!key) continue;
      let state = stateByDate.get(key);
      if (!state) {
        state = { complete: true, total: 0, reasons: new Set() };
        stateByDate.set(key, state);
      }
      if (!rowIsComplete(row)) state.complete = false;
      for (const reason of row?.exclusion_reasons || []) state.reasons.add(reason);
      if (rowIsComplete(row)) state.total += finiteNumber(row.play_count) || 0;
    }

    const result = [];
    let previousDate = null;
    for (const row of values) {
      const key = String(row?.play_date || '');
      const state = stateByDate.get(key) || { complete: false, total: 0, reasons: new Set() };
      if (key !== previousDate) {
        result.push({
          _daily_total: true,
          _period_excluded: !state.complete,
          play_date: key,
          title: state.complete ? 'この日の延べ曲数' : 'この日の延べ曲数（集計対象外）',
          artist: '—',
          play_count: state.complete ? state.total : null,
          daily_share: state.complete ? 100 : null,
          like_count: null,
          first_played_at: null,
          last_played_at: null,
          period_complete: state.complete,
          exclusion_reasons: [...state.reasons],
        });
        previousDate = key;
      }
      result.push({
        ...row,
        daily_share: state.complete && state.total > 0
          ? (finiteNumber(row.play_count) || 0) / state.total * 100
          : null,
      });
    }
    return result;
  };

  function mondayJstKey(now = Date.now()) {
    const shifted = new Date(now + 9 * 3600000);
    const monday = new Date(Date.UTC(
      shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(),
    ));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  }

  function trustedEmailWeek(key) {
    return key >= '2026-01-01' && key < '2026-07-01';
  }

  function weeklyMetricComplete(row) {
    const key = String(row?.ranking_date || row?.period_key || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
    if (key === mondayJstKey()) return false;
    if (trustedEmailWeek(key)) return true;
    if (row?.period_complete === false || row?.stream_growth_excluded === true) return false;
    const expectedStart = Date.parse(`${key}T00:00:00+09:00`);
    const expectedEnd = expectedStart + 7 * DAY_MS;
    const first = finiteNumber(row?.period_start);
    const last = finiteNumber(row?.period_end);
    return first != null && last != null
      && first <= expectedStart + TOLERANCE_MS
      && last >= expectedEnd - TOLERANCE_MS;
  }

  renderWeeklyMetrics = function renderValidatedWeeklyMetrics(rows) {
    const validated = (Array.isArray(rows) ? rows : []).map((row) => weeklyMetricComplete(row)
      ? row
      : {
          ...row,
          stream_growth: null,
          period_complete: false,
          stream_growth_excluded: true,
        });
    return baseRenderWeeklyMetrics(validated);
  };
})();
