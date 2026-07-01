(() => {
  const baseDraw = draw;
  const baseSetMode = setMode;
  const METRICS = [
    ['listener_avg', '平均同接', 1, 2.6],
    ['stream_growth', '再生数増加', 1, 2.6],
    ['listener_min', '最小同接', 0.38, 1.2],
    ['listener_max', '最大同接', 0.38, 1.2],
    ['member_growth', 'メンバー増加', 0.38, 1.2],
  ];
  const COLORS = ['#f6c7d9', '#9c7bf4', '#7ee787', '#ffb86b', '#7ad7ff'];
  const detailFormatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
  let summaryModelSource = null;
  let summaryModelMode = null;
  let summaryModel = null;

  function sampledGapThreshold(times) {
    const gaps = [];
    for (let index = 1; index < times.length; index += 1) {
      const previous = times[index - 1];
      const current = times[index];
      if (previous != null && current != null && current > previous) gaps.push(current - previous);
    }
    gaps.sort((a, b) => a - b);
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    const base = currentMode === 'daily' ? 1.5 * 86400000
      : currentMode === 'monthly' ? 45 * 86400000
        : 10 * 86400000;
    return Math.max(base, median * 2.5);
  }

  function positionsFromTimes(times, area) {
    let minimum = Infinity;
    let maximum = -Infinity;
    let validCount = 0;
    for (const time of times) {
      if (time == null) continue;
      validCount += 1;
      minimum = Math.min(minimum, time);
      maximum = Math.max(maximum, time);
    }
    const span = maximum - minimum;
    const positions = new Array(times.length);
    const denominator = Math.max(1, times.length - 1);
    for (let index = 0; index < times.length; index += 1) {
      const time = times[index];
      positions[index] = validCount >= 2 && span > 0 && time != null
        ? area.left + area.width * (time - minimum) / span
        : area.left + area.width * index / denominator;
    }
    return positions;
  }

  function prepareSeries(sampled) {
    const dates = new Array(sampled.length);
    const times = new Array(sampled.length);
    const metrics = METRICS.map(([key, label, alpha, lineWidth], index) => ({
      key,
      label,
      alpha,
      lineWidth,
      color: COLORS[index % COLORS.length],
      values: new Array(sampled.length),
      minimum: Infinity,
      maximum: -Infinity,
      active: false,
    }));

    for (let index = 0; index < sampled.length; index += 1) {
      const row = sampled[index];
      const date = rowDate(row);
      dates[index] = date;
      times[index] = dateTimestamp(date);
      for (const metric of metrics) {
        const value = finiteNumber(row[metric.key]);
        metric.values[index] = value;
        if (value == null) continue;
        metric.active = true;
        metric.minimum = Math.min(metric.minimum, value);
        metric.maximum = Math.max(metric.maximum, value);
      }
    }

    return {
      dates,
      times,
      gapThreshold: sampledGapThreshold(times),
      metrics: metrics.filter((metric) => metric.active),
    };
  }

  function summaryModelFor(source) {
    if (summaryModelSource === source && summaryModelMode === currentMode && summaryModel) {
      return { model: summaryModel, rebuilt: false };
    }
    const sorted = [...source].sort(
      (a, b) => (dateTimestamp(rowDate(a)) || 0) - (dateTimestamp(rowDate(b)) || 0),
    );
    const sampled = sampleRows(sorted);
    const prepared = prepareSeries(sampled);
    const series = prepared.metrics.map((metric) => ({
      key: metric.key,
      label: metric.label,
      color: metric.color,
      alpha: metric.alpha,
    }));
    summaryModelSource = source;
    summaryModelMode = currentMode;
    summaryModel = {
      sampled,
      ...prepared,
      series,
      legendHtml: series.map((item) =>
        `<span style="opacity:${item.alpha}"><i style="background:${item.color}"></i>${escapeHtml(item.label)}</span>`,
      ).join(''),
    };
    return { model: summaryModel, rebuilt: true };
  }

  function detailValue(value) {
    const number = finiteNumber(value);
    return number == null ? '—' : detailFormatter.format(number);
  }

  function drawSummary(rows, selectedIndex = null) {
    const { ctx, width, height } = prepareCanvas();
    const source = Array.isArray(rows) ? rows : [];
    const { model, rebuilt } = summaryModelFor(source);
    const {
      sampled, dates, times, gapThreshold, metrics, series, legendHtml,
    } = model;
    if (!sampled.length || !metrics.length) return drawEmpty(ctx, width, height);

    const area = { left: 42, right: 18, top: 18, bottom: 42 };
    area.width = Math.max(1, width - area.left - area.right);
    area.height = Math.max(1, height - area.top - area.bottom);
    drawGrid(ctx, width, height, area);
    const xs = positionsFromTimes(times, area);
    drawDateAxis(ctx, dates, xs, width, height, area);

    for (const metric of metrics) {
      const range = metric.maximum - metric.minimum || 1;
      ctx.save();
      ctx.globalAlpha = metric.alpha;
      ctx.strokeStyle = metric.color;
      ctx.lineWidth = metric.lineWidth;
      ctx.beginPath();
      let open = false;
      for (let index = 0; index < metric.values.length; index += 1) {
        const value = metric.values[index];
        if (value == null) {
          open = false;
          continue;
        }
        const y = area.top + area.height - (value - metric.minimum) / range * area.height;
        const gap = index > 0 && times[index] != null && times[index - 1] != null
          && times[index] - times[index - 1] > gapThreshold;
        if (!open || gap) ctx.moveTo(xs[index], y);
        else ctx.lineTo(xs[index], y);
        open = true;
      }
      ctx.stroke();
      ctx.restore();
    }

    const selected = Number.isInteger(selectedIndex) && sampled[selectedIndex] ? selectedIndex : null;
    if (selected != null) drawSelection(ctx, xs[selected], area);
    chartState = { type: 'multi-summary', rows: sampled, dates, xPositions: xs, series, selectedIndex: selected };
    if (rebuilt) {
      setChartRange(dates);
      if ($('#chartLegend').innerHTML !== legendHtml) $('#chartLegend').innerHTML = legendHtml;
    }

    if (selected != null) {
      const row = sampled[selected];
      const detailHtml = `<time>${escapeHtml(formatDate(dates[selected]))}</time>`
        + `<div class="chart-detail-values">${series.map((item) =>
          `<div style="opacity:${item.alpha}"><i style="background:${item.color}"></i>`
          + `<strong>${escapeHtml(item.label)}</strong><span>${detailValue(row[item.key])}</span></div>`,
        ).join('')}</div>`;
      if ($('#chartDetail').innerHTML !== detailHtml) $('#chartDetail').innerHTML = detailHtml;
    }
  }

  draw = function drawMultiSummary(rows, metric, selected) {
    return ['daily', 'weekly', 'monthly'].includes(currentMode)
      ? drawSummary(rows, selected)
      : baseDraw(rows, metric, selected);
  };

  setMode = function setMultiSummaryMode(mode) {
    baseSetMode(mode);
    if (['daily', 'weekly', 'monthly'].includes(mode)) {
      $('#metric').hidden = true;
      $('#metric').disabled = true;
      if ($('#chartTitle').textContent !== '主要指標の推移') $('#chartTitle').textContent = '主要指標の推移';
      const foot = '平均同接と再生数増加を強調表示。各指標は個別スケールです。';
      if ($('#chartFoot').textContent !== foot) $('#chartFoot').textContent = foot;
    }
  };

  function selectPoint(event) {
    if (chartState?.type !== 'multi-summary') return;
    event.stopImmediatePropagation();
    const rect = $('#chart').getBoundingClientRect();
    const x = (event.touches?.[0]?.clientX ?? event.clientX) - rect.left;
    const index = nearestIndex(chartState.xPositions, x);
    if (index == null) return;
    selectedChartIndex = index;
    drawSummary(current, index);
  }

  $('#chart').addEventListener('click', selectPoint, true);
  $('#chart').addEventListener('touchstart', selectPoint, { capture: true, passive: true });

  setTimeout(() => {
    if (['daily', 'weekly', 'monthly'].includes(currentMode) && current.length) {
      $('#metric').hidden = true;
      $('#metric').disabled = true;
      if ($('#chartTitle').textContent !== '主要指標の推移') $('#chartTitle').textContent = '主要指標の推移';
      drawSummary(current);
    }
  }, 0);
})();
