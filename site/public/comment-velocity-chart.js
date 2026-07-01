(() => {
  const baseDrawChart = drawChart;
  const baseShowDetail = showMainChartDetail;

  function drawVelocityBars(selectionIndex) {
    const canvas = el('chart');
    const sampled = mainChartState?.sampled;
    const xPositions = mainChartState?.xPositions;
    if (!canvas || !sampled?.length || !xPositions?.length) return;

    const values = mainChartState?.commentVelocityValues;
    const maximum = Number(mainChartState?.commentVelocityMax) || 0;
    if (!values?.length || maximum <= 0) return;
    const maxValue = Math.max(1, maximum);
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width || canvas.clientWidth || 1000));
    const height = Math.max(260, Math.min(380, Math.round(width * 0.32)));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const pad = { left: 48, right: 76, top: 20, bottom: 50 };
    const plotBottom = height - pad.bottom;
    const plotHeight = Math.max(1, height - pad.top - pad.bottom);
    const styles = getComputedStyle(document.documentElement);
    const barColor = styles.getPropertyValue('--comment-accent').trim() || '#55d6be';

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'destination-over';

    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value == null || value <= 0) continue;

      const previousGap = index > 0 ? xPositions[index] - xPositions[index - 1] : Infinity;
      const nextGap = index < xPositions.length - 1 ? xPositions[index + 1] - xPositions[index] : Infinity;
      const nearestGap = Math.min(previousGap, nextGap);
      const barWidth = Math.max(2, Math.min(14, Number.isFinite(nearestGap) ? nearestGap * 0.72 : 8));
      const barHeight = Math.max(2, plotHeight * value / maxValue);
      const selected = index === selectionIndex;

      ctx.globalAlpha = selected ? 0.48 : 0.24;
      ctx.fillStyle = barColor;
      ctx.fillRect(xPositions[index] - barWidth / 2, plotBottom - barHeight, barWidth, barHeight);
    }

    ctx.restore();
  }

  drawChart = function drawChartWithVelocity(rows = lastHistoryRows, selectionIndex = selectedMainChartIndex) {
    baseDrawChart(rows, selectionIndex);
    drawVelocityBars(selectionIndex);
  };

  showMainChartDetail = function showDetailWithVelocity(index) {
    baseShowDetail(index);
    const detail = el('mainChartDetail');
    const velocity = mainChartState?.commentVelocityValues?.[index];
    if (!detail) return;
    detail.insertAdjacentHTML(
      'beforeend',
      `<div><span>コメント勢い</span><strong>${Number.isFinite(velocity) ? number(velocity) : '-'}件 / 2分</strong></div>`,
    );
  };
})();
