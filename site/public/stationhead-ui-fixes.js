(() => {
  if (typeof renderNowDisplay === 'function') {
    const baseRenderNowDisplay = renderNowDisplay;
    renderNowDisplay = function patchedRenderNowDisplay(track, progressMs = 0) {
      baseRenderNowDisplay(track, progressMs);
      if (!track) return;
      const copy = document.querySelector('#nowPlaying .track-copy');
      if (!copy) return;
      const count = Number(track.bite_count);
      if (!Number.isFinite(count)) return;
      const node = document.createElement('p');
      node.className = 'now-playing-bites';
      node.textContent = `♡${count.toLocaleString('ja-JP')}`;
      const artist = copy.querySelector('p');
      const anchor = artist || copy.querySelector('h3');
      anchor?.insertAdjacentElement('afterend', node);
    };
  }

  if (typeof drawChart === 'function' && typeof showMainChartDetail === 'function') {
    drawChart = function drawOnlineChart(rows = lastHistoryRows, selectionIndex = selectedMainChartIndex) {
      const canvas = el('chart');
      if (!canvas) return;
      const sampled = downsampleRows(rows);
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(320, Math.round(rect.width || canvas.clientWidth || 1000));
      const height = Math.max(260, Math.min(380, Math.round(width * 0.32)));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (!sampled.length) {
        mainChartState = null;
        return;
      }

      const pad = { left: 48, right: 18, top: 20, bottom: 50 };
      const plotWidth = Math.max(1, width - pad.left - pad.right);
      const plotHeight = Math.max(1, height - pad.top - pad.bottom);
      const onlineValues = sampled.map((row) => Number(row.online_member_count)).filter(Number.isFinite);
      if (!onlineValues.length) {
        mainChartState = null;
        return;
      }

      const times = sampled.map((row) => Number(row.observed_at));
      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);
      const timeSpan = Math.max(1, maxTime - minTime);
      const xPositions = times.map((time, index) => Number.isFinite(time)
        ? pad.left + plotWidth * (time - minTime) / timeSpan
        : pad.left + plotWidth * index / Math.max(1, sampled.length - 1));
      const intervals = times.slice(1).map((time, index) => time - times[index]).filter((value) => value > 0).sort((a, b) => a - b);
      const medianInterval = intervals.length ? intervals[Math.floor(intervals.length / 2)] : 60_000;
      const gapThreshold = Math.max(5 * 60_000, medianInterval * 4);
      const rawMin = Math.min(...onlineValues);
      const rawMax = Math.max(...onlineValues);
      const padding = Math.max(5, (rawMax - rawMin) * 0.08);
      const scale = {
        min: Math.max(0, rawMin - padding),
        max: rawMax + padding,
      };
      scale.range = Math.max(1, scale.max - scale.min);
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
      sampled.forEach((row, index) => {
        const value = Number(row.online_member_count);
        const temporalGap = index > 0 && times[index] - times[index - 1] > gapThreshold;
        if (!Number.isFinite(value) || temporalGap) started = false;
        if (!Number.isFinite(value)) return;
        const x = xPositions[index];
        const y = yFor(value);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();

      const tickTarget = Math.max(5, Math.min(14, Math.floor(plotWidth / 72)));
      const tickIndices = [...new Set(Array.from({ length: tickTarget }, (_, index) =>
        Math.round((sampled.length - 1) * index / Math.max(1, tickTarget - 1))))];
      ctx.font = '11px system-ui';
      ctx.fillStyle = muted;
      ctx.textBaseline = 'top';
      let lastRight = -Infinity;
      tickIndices.forEach((index, position) => {
        const date = new Date(times[index]);
        const crossesDate = new Date(minTime).toLocaleDateString('ja-JP') !== new Date(maxTime).toLocaleDateString('ja-JP');
        const label = crossesDate
          ? date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
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

      mainChartState = { sampled, xPositions };
    };

    showMainChartDetail = function showOnlineDetail(index) {
      if (!mainChartState || !Number.isInteger(index)) return;
      const row = mainChartState.sampled[index];
      if (!row) return;
      selectedMainChartIndex = index;
      const detail = el('mainChartDetail');
      if (detail) {
        detail.innerHTML = `<time>${escapeText(new Date(Number(row.observed_at)).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</time>` +
          `<div><span>オンライン</span><strong>${number(row.online_member_count)}人</strong></div>`;
      }
      drawChart(lastHistoryRows, index);
    };
  }

  const modeTabs = document.querySelectorAll('.mode-tabs button');
  if (!modeTabs.length || typeof load !== 'function' || typeof setMode !== 'function') return;

  let pendingReload = null;
  const clearChartPresentation = () => {
    document.querySelector('#chartLegend')?.replaceChildren();
    const detail = document.querySelector('#chartDetail');
    if (detail) detail.innerHTML = '<span>グラフをタッチまたはクリックすると、その時点の詳細を表示します。</span>';
    const canvas = document.querySelector('#chart');
    const context = canvas?.getContext('2d');
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
  };
  const loadWhenReady = () => {
    clearTimeout(pendingReload);
    const run = () => {
      if (loading) {
        pendingReload = setTimeout(run, 50);
        return;
      }
      nextCursor = null;
      load();
    };
    run();
  };

  const baseSetMode = setMode;
  setMode = function patchedSetMode(mode) {
    clearChartPresentation();
    baseSetMode(mode);
  };

  modeTabs.forEach((button) => {
    button.onclick = () => {
      setMode(button.dataset.mode);
      loadWhenReady();
    };
  });
  document.querySelectorAll('.range-presets button').forEach((button) => {
    button.onclick = () => {
      applyPreset(button.dataset.days);
      clearChartPresentation();
      loadWhenReady();
    };
  });
  const loadButton = document.querySelector('#load');
  if (loadButton) loadButton.onclick = () => {
    clearChartPresentation();
    loadWhenReady();
  };
})();
