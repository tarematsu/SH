(() => {
  const baseReadCache = readCache;
  const baseWriteCache = writeCache;
  const baseRenderWeeklyMetrics = renderWeeklyMetrics;

  function finalCacheKey(key) {
    return String(key || '')
      .replace(/^track-history:v11:/, 'track-history:v13:')
      .replace(/^history:v9:/, 'history:v11:');
  }

  readCache = function readValidatedCache(key) {
    return baseReadCache(finalCacheKey(key));
  };

  writeCache = function writeValidatedCache(key, data) {
    return baseWriteCache(finalCacheKey(key), data);
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
      const complete = rowIsComplete(row);
      if (!complete) state.complete = false;
      for (const reason of row?.exclusion_reasons || []) state.reasons.add(reason);
      if (complete) state.total += finiteNumber(row.play_count) || 0;
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

  function weeklyMetricComplete(row) {
    return row?.period_complete !== false
      && row?.stream_growth_excluded !== true
      && finiteNumber(row?.stream_growth) != null;
  }

  renderWeeklyMetrics = function renderValidatedWeeklyMetrics(rows) {
    const values = Array.isArray(rows) ? rows : [];
    const validated = new Array(values.length);
    for (let index = 0; index < values.length; index += 1) {
      const row = values[index];
      validated[index] = weeklyMetricComplete(row)
        ? row
        : {
            ...row,
            stream_growth: null,
            period_complete: false,
            stream_growth_excluded: true,
          };
    }
    return baseRenderWeeklyMetrics(validated);
  };
})();
