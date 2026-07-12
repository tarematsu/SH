(() => {
  const integerFormatter = new Intl.NumberFormat('ja-JP');
  const tickDateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const tickTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit', minute: '2-digit',
  });
  const dayKeyFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const detailDateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const integerText = (value) => value == null || !Number.isFinite(Number(value))
    ? '-' : integerFormatter.format(Number(value));

  if (typeof renderNowDisplay === 'function') {
    const baseRenderNowDisplay = renderNowDisplay;
    renderNowDisplay = function patchedRenderNowDisplay(track, progressMs = 0, host = {}) {
      baseRenderNowDisplay(track, progressMs, host);
      if (!track) return;
      const copy = document.querySelector('#nowPlaying .track-copy');
      if (!copy) return;
      const count = Number(track.bite_count);
      if (!Number.isFinite(count)) return;
      const node = document.createElement('p');
      node.className = 'now-playing-bites';
      node.textContent = `♡${integerFormatter.format(count)}`;
      const artist = copy.querySelector('p');
      const anchor = artist || copy.querySelector('h3');
      anchor?.insertAdjacentElement('afterend', node);
    };
  }

  function renderGoalMilestones(predictions, configuredGoal) {
    const root = el('goalMilestones');
    if (!root) return;
    const configured = Number(configuredGoal);
    const extras = (Array.isArray(predictions) ? predictions : [])
      .filter((prediction) => {
        const target = Number(prediction?.goal);
        const eta = Number(prediction?.eta);
        return Number.isFinite(target) && Number.isFinite(eta)
          && (!Number.isFinite(configured) || target !== configured);
      })
      .sort((left, right) => Number(left.goal) - Number(right.goal));
    const signature = extras.map((prediction) => [
      prediction.goal,
      prediction.eta,
      prediction.rate_per_hour,
    ].join(':')).join('|');
    if (root.dataset.signature === signature) return;
    root.dataset.signature = signature;
    root.replaceChildren(...extras.map((prediction) => {
      const item = document.createElement('div');
      item.className = 'goal-milestone';
      const target = document.createElement('strong');
      target.textContent = integerFormatter.format(Number(prediction.goal));
      const eta = document.createElement('span');
      eta.textContent = etaDateTime(prediction.eta);
      const rate = document.createElement('em');
      rate.textContent = `+${integerFormatter.format(Math.round(Number(prediction.rate_per_hour)))} /h`;
      item.append(target, eta, rate);
      return item;
    }));
  }

  if (typeof renderPrediction === 'function') {
    renderPrediction = function renderPredictionDifferential(prediction, current, goal, predictions) {
      const eta = el('goalEta');
      const rate = el('goalRate');
      if (!eta || !rate) return;
      const etaText = prediction
        ? etaDateTime(prediction.eta)
        : current >= goal && goal > 0 ? '目標達成済み' : '予測データ不足';
      const rateText = prediction
        ? `平均 +${integerText(Math.round(prediction.rate_per_hour))} /時`
        : '最低15分以上の履歴が必要です';
      if (eta.textContent !== etaText) eta.textContent = etaText;
      if (rate.textContent !== rateText) rate.textContent = rateText;
      renderGoalMilestones(predictions, goal);
    };
  }

  if (typeof drawChart !== 'function' || typeof showMainChartDetail !== 'function') return;

  let mainChartModelSource = null;
  let mainChartModelWidth = 0;
  let mainChartModelHeight = 0;
  let mainChartModel = null;

  function prepareMainChartModel(rows, width, height) {
    if (
      mainChartModelSource === rows
      && mainChartModelWidth === width
      && mainChartModelHeight === height
      && mainChartModel
    ) return mainChartModel;

    const sampled = downsampleRows(rows);
    if (!sampled.length) {
      mainChartModelSource = rows;
      mainChartModelWidth = width;
      mainChartModelHeight = height;
      mainChartModel = null;
      return null;
    }

    const pad = { left: 48, right: 18, top: 20, bottom: 50 };
    const plotWidth = Math.max(1, width - pad.left - pad.right);
    const plotHeight = Math.max(1, height - pad.top - pad.bottom);
    const times = new Array(sampled.length);
    const commentVelocityValues = new Array(sampled.length);
    const intervals = [];
    let minTime = Infinity;
    let maxTime = -Infinity;
    let rawMin = Infinity;
    let rawMax = -Infinity;
    let commentVelocityMax = 0;
    let previousTime = null;

    for (let index = 0; index < sampled.length; index += 1) {
      const row = sampled[index];
      const time = Number(row.observed_at);
      times[index] = time;
      if (Number.isFinite(time)) {
        minTime = Math.min(minTime, time);
        maxTime = Math.max(maxTime, time);
        if (previousTime != null && time > previousTime) intervals.push(time - previousTime);
        previousTime = time;
      }
      const online = Number(row.online_member_count);
      if (Number.isFinite(online)) {
        rawMin = Math.min(rawMin, online);
        rawMax = Math.max(rawMax, online);
      }
      const velocity = Number(row.comment_velocity);
      commentVelocityValues[index] = Number.isFinite(velocity) ? velocity : null;
      if (Number.isFinite(velocity)) commentVelocityMax = Math.max(commentVelocityMax, velocity);
    }
    if (!Number.isFinite(rawMin)) return null;
    if (!Number.isFinite(minTime)) {
      minTime = 0;
      maxTime = Math.max(1, sampled.length - 1);
    }

    const timeSpan = Math.max(1, maxTime - minTime);
    const xPositions = new Array(times.length);
    const denominator = Math.max(1, sampled.length - 1);
    for (let index = 0; index < times.length; index += 1) {
      const time = times[index];
      xPositions[index] = Number.isFinite(time)
        ? pad.left + plotWidth * (time - minTime) / timeSpan
        : pad.left + plotWidth * index / denominator;
    }
    intervals.sort((a, b) => a - b);
    const medianInterval = intervals.length ? intervals[Math.floor(intervals.length / 2)] : 60_000;
    const gapThreshold = Math.max(5 * 60_000, medianInterval * 4);
    const padding = Math.max(5, (rawMax - rawMin) * 0.08);
    const scale = { min: Math.max(0, rawMin - padding), max: rawMax + padding };
    scale.range = Math.max(1, scale.max - scale.min);
    const tickTarget = Math.max(5, Math.min(14, Math.floor(plotWidth / 72)));
    const tickIndices = [];
    let previousTick = -1;
    for (let index = 0; index < tickTarget; index += 1) {
      const tick = Math.round((sampled.length - 1) * index / Math.max(1, tickTarget - 1));
      if (tick !== previousTick) tickIndices.push(tick);
      previousTick = tick;
    }

    mainChartModelSource = rows;
    mainChartModelWidth = width;
    mainChartModelHeight = height;
    mainChartModel = {
      sampled,
      pad,
      plotWidth,
      plotHeight,
      times,
      xPositions,
      gapThreshold,
      scale,
      tickIndices,
      minTime,
      maxTime,
      commentVelocityValues,
      commentVelocityMax,
    };
    return mainChartModel;
  }

  drawChart = function drawOnlineChartCachedModel(rows = lastHistoryRows, selectionIndex = selectedMainChartIndex) {
    const canvas = el('chart');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width || canvas.clientWidth || 1000));
    const height = Math.max(260, Math.min(380, Math.round(width * 0.32)));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const cssHeight = `${height}px`;
    if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const model = prepareMainChartModel(rows, width, height);
    if (!model) {
      mainChartState = null;
      return;
    }
    const {
      sampled, pad, plotHeight, times, xPositions, gapThreshold, scale,
      tickIndices, minTime, maxTime, commentVelocityValues, commentVelocityMax,
    } = model;
    const styles = getComputedStyle(document.documentElement);
    const muted = styles.getPropertyValue('--muted').trim() || '#aaa3b5';
    const onlineColor = styles.getPropertyValue('--accent').trim() || '#ff7aa8';
    const yFor = (value) => height - pad.bottom - (value - scale.min) * plotHeight / scale.range;

    ctx.font = '12px system-ui';
    ctx.lineWidth = 1;
    for (let index = 0; index <= 4; index += 1) {
      const ratio = index / 4;
      const y = pad.top + plotHeight * ratio;
      ctx.strokeStyle = 'rgba(255,255,255,.08)';
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();
      ctx.fillStyle = onlineColor;
      ctx.fillText(String(Math.round(scale.max - scale.range * ratio)), 5, y + 4);
    }

    ctx.strokeStyle = onlineColor;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let started = false;
    for (let index = 0; index < sampled.length; index += 1) {
      const value = Number(sampled[index].online_member_count);
      const temporalGap = index > 0 && Number.isFinite(times[index]) && Number.isFinite(times[index - 1])
        && times[index] - times[index - 1] > gapThreshold;
      if (!Number.isFinite(value) || temporalGap) started = false;
      if (!Number.isFinite(value)) continue;
      const x = xPositions[index];
      const y = yFor(value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    const crossesDate = dayKeyFormatter.format(new Date(minTime)) !== dayKeyFormatter.format(new Date(maxTime));
    const tickFormatter = crossesDate ? tickDateTimeFormatter : tickTimeFormatter;
    ctx.font = '11px system-ui';
    ctx.fillStyle = muted;
    ctx.textBaseline = 'top';
    let lastRight = -Infinity;
    tickIndices.forEach((index, position) => {
      const label = tickFormatter.format(new Date(times[index]));
      const measured = ctx.measureText(label).width;
      const x = Math.max(pad.left, Math.min(width - pad.right - measured, xPositions[index] - measured / 2));
      if (x > lastRight + 7 || position === tickIndices.length - 1) {
        ctx.fillText(label, x, height - pad.bottom + 12);
        lastRight = x + measured;
      }
    });

    if (Number.isInteger(selectionIndex) && selectionIndex >= 0 && selectionIndex < sampled.length) {
      const x = xPositions[selectionIndex];
      const online = Number(sampled[selectionIndex].online_member_count);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.65)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, height - pad.bottom);
      ctx.stroke();
      ctx.restore();
      if (Number.isFinite(online)) {
        ctx.beginPath();
        ctx.fillStyle = '#fff';
        ctx.arc(x, yFor(online), 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = onlineColor;
        ctx.arc(x, yFor(online), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    mainChartState = {
      sampled,
      xPositions,
      commentVelocityValues,
      commentVelocityMax,
    };
  };

  showMainChartDetail = function showOnlineDetail(index) {
    if (!mainChartState || !Number.isInteger(index)) return;
    const row = mainChartState.sampled[index];
    if (!row) return;
    selectedMainChartIndex = index;
    const detail = el('mainChartDetail');
    if (detail) {
      const html = `<time>${escapeText(detailDateTimeFormatter.format(new Date(Number(row.observed_at))))}</time>`
        + `<div><span>オンライン</span><strong>${integerText(row.online_member_count)}人</strong></div>`;
      if (detail.innerHTML !== html) detail.innerHTML = html;
    }
    drawChart(lastHistoryRows, index);
  };
})();
