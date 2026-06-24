(() => {
  const baseDrawChart = drawChart;
  const baseShowDetail = showMainChartDetail;
  const velocityByBucket = new Map();
  let loading = false;

  const bucketAt = (value) => Math.floor(Number(value) / 300000) * 300000;

  function mergeVelocity(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      const stored = velocityByBucket.get(bucketAt(row?.observed_at));
      return stored == null ? row : { ...row, comment_velocity: stored };
    });
  }

  function drawVelocityBars(selectionIndex) {
    const canvas = el('chart');
    const sampled = mainChartState?.sampled;
    const xPositions = mainChartState?.xPositions;
    if (!canvas || !sampled?.length || !xPositions?.length) return;

    const values = sampled.map((row) => Number(row.comment_velocity));
    const finiteValues = values.filter(Number.isFinite);
    if (!finiteValues.length) return;

    const maxValue = Math.max(1, ...finiteValues);
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

    sampled.forEach((row, index) => {
      const value = Number(row.comment_velocity);
      if (!Number.isFinite(value) || value <= 0) return;

      const previousGap = index > 0 ? xPositions[index] - xPositions[index - 1] : Infinity;
      const nextGap = index < xPositions.length - 1 ? xPositions[index + 1] - xPositions[index] : Infinity;
      const nearestGap = Math.min(previousGap, nextGap);
      const barWidth = Math.max(2, Math.min(14, Number.isFinite(nearestGap) ? nearestGap * 0.72 : 8));
      const barHeight = Math.max(2, plotHeight * value / maxValue);
      const selected = index === selectionIndex;

      ctx.globalAlpha = selected ? 0.48 : 0.24;
      ctx.fillStyle = barColor;
      ctx.fillRect(xPositions[index] - barWidth / 2, plotBottom - barHeight, barWidth, barHeight);
    });

    ctx.restore();
  }

  drawChart = function drawChartWithVelocity(rows = lastHistoryRows, selectionIndex = selectedMainChartIndex) {
    baseDrawChart(mergeVelocity(rows), selectionIndex);
    drawVelocityBars(selectionIndex);
  };

  showMainChartDetail = function showDetailWithVelocity(index) {
    baseShowDetail(index);
    const row = mainChartState?.sampled?.[index];
    const detail = el('mainChartDetail');
    const velocity = Number(row?.comment_velocity);
    if (!detail) return;
    detail.insertAdjacentHTML(
      'beforeend',
      `<div><span>コメント勢い</span><strong>${Number.isFinite(velocity) ? number(velocity) : '-'}件 / 2分</strong></div>`,
    );
  };

  async function refreshVelocity() {
    if (loading) return;
    loading = true;
    try {
      const response = await fetch('/api/comment-velocity', {
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`comment velocity API ${response.status}`);
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'comment velocity API error');

      velocityByBucket.clear();
      for (const row of data.rows || []) {
        const key = Number(row.bucket_at);
        const value = Number(row.comment_velocity);
        if (Number.isFinite(key) && Number.isFinite(value)) velocityByBucket.set(key, value);
      }

      if (lastHistoryRows.length) requestAnimationFrame(() => drawChart(lastHistoryRows, selectedMainChartIndex));
    } catch (error) {
      console.warn(error);
    } finally {
      loading = false;
    }
  }

  refreshVelocity();
  setInterval(() => {
    if (!document.hidden) refreshVelocity();
  }, 120000);
})();
