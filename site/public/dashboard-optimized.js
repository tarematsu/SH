(() => {
  const integerFormatter = new Intl.NumberFormat('ja-JP');

  renderOnlineRange = function renderOnlineRangeSafe(rows = lastHistoryRows) {
    const target = el('onlineRange24h');
    if (!target) return;
    const cutoff = Date.now() - 86400000;
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const row of Array.isArray(rows) ? rows : []) {
      if (Number(row?.observed_at) < cutoff) continue;
      const value = Number(row?.online_member_count);
      if (!Number.isFinite(value)) continue;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    target.innerHTML = Number.isFinite(minimum)
      ? `<span>24時間最低 ${integerFormatter.format(minimum)}</span><span>24時間最高 ${integerFormatter.format(maximum)}</span>`
      : '<span>24時間最低 -</span><span>24時間最高 -</span>';
  };

  const baseDrawChart = drawChart;
  drawChart = function drawChartWithoutDiscardingHistory(rows = lastHistoryRows, selectionIndex = selectedMainChartIndex) {
    const fullRows = Array.isArray(rows) ? rows : [];
    baseDrawChart(fullRows, selectionIndex);
    lastHistoryRows = fullRows;
  };
})();
