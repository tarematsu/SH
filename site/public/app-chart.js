function downsampleRows(rows, maxPoints = 300) {
  if (!Array.isArray(rows)) return [];
  const valid = rows.filter(row => Number.isFinite(Number(row?.observed_at)));
  if (valid.length <= maxPoints) return valid;
  const step = (valid.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, i) => valid[Math.round(i * step)]);
}

function commentVelocityState(sampled) {
  const values = sampled.map((row) => {
    const value = Number(row?.comment_velocity ?? row?.comment_velocity_max);
    return Number.isFinite(value) ? Math.max(0, value) : null;
  });
  const maximum = values.reduce((max, value) => (
    Number.isFinite(value) ? Math.max(max, value) : max
  ), 0);
  return { values, maximum };
}

function drawCommentVelocityBars(ctx, dimensions, xPositions, velocityValues, velocityMaximum, selectionIndex) {
  if (!velocityValues?.length || velocityMaximum <= 0) return;
  const { height, dpr, pad, plotHeight } = dimensions;
  const plotBottom = height - pad.bottom;
  const styles = getComputedStyle(document.documentElement);
  const barColor = styles.getPropertyValue('--comment-accent').trim() || '#55d6be';

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = barColor;
  for (let index = 0; index < velocityValues.length; index += 1) {
    const value = velocityValues[index];
    if (value == null || value <= 0) continue;
    const previousGap = index > 0 ? xPositions[index] - xPositions[index - 1] : Infinity;
    const nextGap = index < xPositions.length - 1 ? xPositions[index + 1] - xPositions[index] : Infinity;
    const nearestGap = Math.min(previousGap, nextGap);
    const barWidth = Math.max(2, Math.min(14, Number.isFinite(nearestGap) ? nearestGap * 0.68 : 8));
    const barHeight = Math.max(3, plotHeight * value / Math.max(1, velocityMaximum));
    ctx.globalAlpha = index === selectionIndex ? 0.58 : 0.34;
    ctx.fillRect(xPositions[index] - barWidth / 2, plotBottom - barHeight, barWidth, barHeight);
  }
  ctx.restore();
}

function drawChart(rows = lastHistoryRows, selectionIndex = selectedMainChartIndex) {
  const canvas = el('chart');
  if (!canvas) return;

  const sampled = downsampleRows(rows);
  if (!sampled.length) return;
  lastHistoryRows = sampled;

  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.round(rect.width || canvas.clientWidth || 1000));
  const height = Math.max(260, Math.min(380, Math.round(width * 0.32)));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);

  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = { left: 48, right: 76, top: 20, bottom: 50 };
  const plotWidth = Math.max(1, width - pad.left - pad.right);
  const plotHeight = Math.max(1, height - pad.top - pad.bottom);
  const onlineValues = sampled.map((row) => Number(row.online_member_count)).filter(Number.isFinite);
  const playValues = sampled.map((row) => Number(row.current_stream_count)).filter(Number.isFinite);
  if (!onlineValues.length && !playValues.length) return;

  const times = sampled.map((row) => Number(row.observed_at));
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const timeSpan = Math.max(1, maxTime - minTime);
  const xPositions = times.map((time, index) => Number.isFinite(time)
    ? pad.left + plotWidth * (time - minTime) / timeSpan
    : pad.left + plotWidth * index / Math.max(1, sampled.length - 1));

  const intervals = times.slice(1).map((time, index) => time - times[index]).filter((value) => value > 0).sort((a, b) => a - b);
  const medianInterval = intervals.length ? intervals[Math.floor(intervals.length / 2)] : 5 * 60_000;
  const gapThreshold = Math.max(10 * 60_000, medianInterval * 4);

  const rangeFor = (values, minimumPadding = 1) => {
    if (!values.length) return { min: 0, max: 1, range: 1 };
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const padding = Math.max(minimumPadding, (rawMax - rawMin) * 0.08);
    const min = Math.max(0, rawMin - padding);
    const max = rawMax + padding;
    return { min, max, range: Math.max(1, max - min) };
  };

  const onlineScale = rangeFor(onlineValues, 5);
  const playScale = rangeFor(playValues, 10);
  const styles = getComputedStyle(document.documentElement);
  const muted = styles.getPropertyValue('--muted').trim() || '#aaa3b5';
  const onlineColor = styles.getPropertyValue('--accent').trim() || '#ff7aa8';
  const playColor = styles.getPropertyValue('--accent-2').trim() || '#9c7bf4';
  const compact = new Intl.NumberFormat('ja-JP', { notation: 'compact', maximumFractionDigits: 1 });

  ctx.font = '12px system-ui';
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const ratio = i / 4;
    const y = pad.top + plotHeight * ratio;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();

    ctx.fillStyle = onlineColor;
    ctx.fillText(String(Math.round(onlineScale.max - onlineScale.range * ratio)), 5, y + 4);
    ctx.fillStyle = playColor;
    ctx.fillText(compact.format(Math.round(playScale.max - playScale.range * ratio)), width - pad.right + 9, y + 4);
  }

  const velocity = commentVelocityState(sampled);
  drawCommentVelocityBars(ctx, { height, dpr, pad, plotHeight }, xPositions, velocity.values, velocity.maximum, selectionIndex);

  const yFor = (value, scale) => height - pad.bottom - (value - scale.min) * plotHeight / scale.range;
  const drawSeries = (key, scale, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let started = false;
    sampled.forEach((row, index) => {
      const value = Number(row[key]);
      const temporalGap = index > 0 && times[index] - times[index - 1] > gapThreshold;
      if (!Number.isFinite(value) || temporalGap) started = false;
      if (!Number.isFinite(value)) return;
      const x = xPositions[index];
      const y = yFor(value, scale);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  if (onlineValues.length) drawSeries('online_member_count', onlineScale, onlineColor);
  if (playValues.length) drawSeries('current_stream_count', playScale, playColor);

  const tickTarget = Math.max(5, Math.min(14, Math.floor(plotWidth / 72)));
  const tickIndices = [...new Set(Array.from({ length: tickTarget }, (_, i) =>
    Math.round((sampled.length - 1) * i / Math.max(1, tickTarget - 1))))];
  ctx.font = '11px system-ui';
  ctx.fillStyle = muted;
  ctx.textBaseline = 'top';
  let lastRight = -Infinity;
  tickIndices.forEach((index, tickPosition) => {
    const date = new Date(times[index]);
    const crossesDate = new Date(minTime).toLocaleDateString('ja-JP') !== new Date(maxTime).toLocaleDateString('ja-JP');
    const label = crossesDate
      ? date.toLocaleString('ja-JP', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })
      : date.toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit' });
    const measured = ctx.measureText(label).width;
    const x = Math.max(pad.left, Math.min(width - pad.right - measured, xPositions[index] - measured / 2));
    const isLast = tickPosition === tickIndices.length - 1;
    if (x > lastRight + 7 || isLast) {
      ctx.fillText(label, x, height - pad.bottom + 12);
      lastRight = x + measured;
    }
  });

  if (Number.isInteger(selectionIndex) && selectionIndex >= 0 && selectionIndex < sampled.length) {
    const x = xPositions[selectionIndex];
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.65)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, height - pad.bottom);
    ctx.stroke();
    ctx.restore();

    const online = Number(sampled[selectionIndex].online_member_count);
    const plays = Number(sampled[selectionIndex].current_stream_count);
    if (Number.isFinite(online)) {
      ctx.beginPath(); ctx.fillStyle = '#fff'; ctx.arc(x, yFor(online, onlineScale), 5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.fillStyle = onlineColor; ctx.arc(x, yFor(online, onlineScale), 3, 0, Math.PI * 2); ctx.fill();
    }
    if (Number.isFinite(plays)) {
      ctx.beginPath(); ctx.fillStyle = '#fff'; ctx.arc(x, yFor(plays, playScale), 5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.fillStyle = playColor; ctx.arc(x, yFor(plays, playScale), 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  mainChartState = {
    sampled,
    xPositions,
    commentVelocityValues: velocity.values,
    commentVelocityMax: velocity.maximum,
  };
}

function showMainChartDetail(index) {
  if (!mainChartState || !Number.isInteger(index)) return;
  const row = mainChartState.sampled[index];
  if (!row) return;
  selectedMainChartIndex = index;
  const detail = el('mainChartDetail');
  if (detail) {
    const velocity = mainChartState?.commentVelocityValues?.[index];
    detail.innerHTML = `<time>${escapeText(new Date(Number(row.observed_at)).toLocaleString('ja-JP', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' }))}</time>` +
      `<div><span>オンライン</span><strong>${number(row.online_member_count)}人</strong></div>` +
      `<div><span>再生数</span><strong>${number(row.current_stream_count)}</strong></div>` +
      `<div><span>コメント勢い</span><strong>${Number.isFinite(velocity) ? number(velocity) : '-'}件 / 2分</strong></div>`;
  }
  drawChart(lastHistoryRows, index);
}

function selectMainChartPoint(event) {
  if (!mainChartState?.xPositions?.length) return;
  const rect = el('chart').getBoundingClientRect();
  const x = event.clientX - rect.left;
  let nearest = 0;
  let distance = Infinity;
  mainChartState.xPositions.forEach((pointX, index) => {
    const next = Math.abs(pointX - x);
    if (next < distance) { distance = next; nearest = index; }
  });
  showMainChartDetail(nearest);
}
