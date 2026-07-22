(() => {
  const button = document.querySelector('[data-mode="broadcasts"]');
  const canvas = document.getElementById('chart');
  const legend = document.getElementById('chartLegend');
  const notice = document.getElementById('notice');
  const fromInput = document.getElementById('from');
  const toInput = document.getElementById('to');
  if (!button || !canvas || !legend || !notice || !fromInput || !toInput) return;

  const CACHE_MS = 15 * 60_000;
  const MAX_CACHE_POINTS = 30_000;
  const MAX_DRAW_POINTS = 2_400;
  const number = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
  const eventDate = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' });
  let series = [];
  let selectedMinute = null;
  let loadingKey = '';
  let loadedKey = '';
  let loadedMeta = null;
  let controller = null;
  let loadTimer = null;
  let resizeTimer = null;

  const active = () => button.classList.contains('active');
  const escape = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

  function elapsedLabel(minutes) {
    const value = Math.max(0, Math.round(Number(minutes) || 0));
    if (value < 60) return `${value}分`;
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    return rest ? `${hours}時間${rest}分` : `${hours}時間`;
  }

  function eventLabel(item) {
    const startedAt = Number(item.started_at);
    return Number.isFinite(startedAt)
      ? `${eventDate.format(new Date(startedAt))} ${item.event_name || '公式ステヘ'}`
      : item.event_name || '公式ステヘ';
  }

  function colorFor(index, alpha = 1) {
    const hue = (330 + index * 137.508) % 360;
    return `hsla(${hue},72%,72%,${alpha})`;
  }

  function samplePoints(points, maximum = MAX_DRAW_POINTS) {
    if (!Array.isArray(points) || points.length <= maximum) return points || [];
    const result = [points[0]];
    const step = Math.max(1, Math.ceil((points.length - 2) / (maximum - 2)));
    for (let index = 1; index < points.length - 1; index += step) result.push(points[index]);
    result.push(points.at(-1));
    return result;
  }

  function prepareSeries(items) {
    return (Array.isArray(items) ? items : []).map((item) => {
      const points = Array.isArray(item.points) ? item.points : [];
      let maxMinute = 0;
      let maxListener = 0;
      for (const point of points) {
        const minute = Number(point?.[0]);
        const listener = Number(point?.[1]);
        if (Number.isFinite(minute)) maxMinute = Math.max(maxMinute, minute);
        if (Number.isFinite(listener)) maxListener = Math.max(maxListener, listener);
      }
      return { ...item, points, drawPoints: samplePoints(points), maxMinute, maxListener };
    });
  }

  function nearestPoint(points, targetMinute) {
    if (!points?.length) return null;
    let low = 0;
    let high = points.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (Number(points[middle][0]) < targetMinute) low = middle + 1;
      else high = middle;
    }
    const current = points[low];
    const previous = low > 0 ? points[low - 1] : null;
    if (!previous) return current;
    return Math.abs(Number(previous[0]) - targetMinute) <= Math.abs(Number(current[0]) - targetMinute)
      ? previous
      : current;
  }

  function renderDetail(minute) {
    const detail = document.getElementById('chartDetail');
    if (!detail) return;
    if (minute == null) {
      detail.innerHTML = '<span>グラフをタッチまたはクリックすると、開始後の同じ時点で全放送を比較できます。</span>';
      return;
    }
    const values = series.map((item, index) => ({
      item,
      index,
      point: nearestPoint(item.points, minute),
    })).filter(({ point }) => point && Math.abs(Number(point[0]) - minute) <= 5);
    detail.innerHTML = `<time>開始から ${elapsedLabel(minute)}</time><div class="chart-detail-values broadcast-detail-values">${values.map(({ item, index, point }) =>
      `<div><i style="background:${colorFor(index)}"></i><strong>${escape(eventLabel(item))}</strong><span>${number.format(Number(point[1]) || 0)}人</span></div>`).join('')}</div>`;
  }

  function draw() {
    if (!active()) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = canvas.clientWidth || 1_000;
    const height = canvas.clientHeight || 330;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const available = series.filter((item) => item.points.length);
    document.getElementById('chartTitle').textContent = '公式ステヘ 同接推移（開始0分比較）';
    document.getElementById('chartFoot').textContent = '各線は1回の公式ステヘです。横軸は各放送の開始からの経過時間です。';
    if (!available.length) {
      context.font = '14px system-ui';
      context.textAlign = 'center';
      context.fillText('表示できる公式ステヘデータがありません', width / 2, height / 2);
      legend.replaceChildren();
      renderDetail(null);
      return;
    }

    const maxMinute = Math.max(1, ...available.map((item) => item.maxMinute));
    const maxListener = Math.max(50, Math.ceil(Math.max(...available.map((item) => item.maxListener)) / 50) * 50);
    const area = { left: 58, right: 18, top: 18, bottom: 42 };
    area.width = Math.max(1, width - area.left - area.right);
    area.height = Math.max(1, height - area.top - area.bottom);
    const xFor = (minute) => area.left + area.width * Math.max(0, Number(minute) || 0) / maxMinute;
    const yFor = (value) => area.top + area.height - area.height * Math.max(0, Number(value) || 0) / maxListener;

    context.lineWidth = 1;
    context.strokeStyle = '#ffffff18';
    context.fillStyle = '#aaa3b5';
    context.font = '10.5px system-ui';
    for (let index = 0; index <= 4; index += 1) {
      const y = area.top + area.height * index / 4;
      context.beginPath();
      context.moveTo(area.left, y);
      context.lineTo(width - area.right, y);
      context.stroke();
      context.textAlign = 'right';
      context.fillText(number.format(Math.round(maxListener * (1 - index / 4))), area.left - 8, y + 3);
    }

    available.forEach((item, index) => {
      context.strokeStyle = colorFor(index, available.length > 12 ? 0.68 : 0.9);
      context.lineWidth = available.length > 16 ? 1.15 : 1.7;
      context.beginPath();
      let open = false;
      for (const point of item.drawPoints) {
        const minute = Number(point?.[0]);
        const listener = Number(point?.[1]);
        if (!Number.isFinite(minute) || !Number.isFinite(listener)) continue;
        if (!open) context.moveTo(xFor(minute), yFor(listener));
        else context.lineTo(xFor(minute), yFor(listener));
        open = true;
      }
      context.stroke();
    });

    if (selectedMinute != null) {
      const x = xFor(selectedMinute);
      context.save();
      context.strokeStyle = '#ffffffb0';
      context.setLineDash([4, 4]);
      context.beginPath();
      context.moveTo(x, area.top);
      context.lineTo(x, area.top + area.height);
      context.stroke();
      context.restore();
    }

    legend.innerHTML = available.map((item, index) =>
      `<span><i style="background:${colorFor(index)}"></i>${escape(eventLabel(item))}</span>`).join('');
    document.getElementById('chartStartDate').textContent = '開始 0分';
    document.getElementById('chartEndDate').textContent = `最長 ${elapsedLabel(maxMinute)}`;
    renderDetail(selectedMinute);
    canvas.dataset.sakurazakaMaxMinute = String(maxMinute);
    canvas.dataset.sakurazakaLeft = String(area.left);
    canvas.dataset.sakurazakaWidth = String(area.width);
  }

  function cacheKey() {
    return `sakurazaka46jp:v1:${fromInput.value}:${toInput.value}`;
  }

  function readCache() {
    try {
      const stored = JSON.parse(sessionStorage.getItem(cacheKey()));
      return stored && Date.now() - stored.at < CACHE_MS ? stored.data : null;
    } catch {
      return null;
    }
  }

  function writeCache(data) {
    if (Number(data?.point_count || 0) > MAX_CACHE_POINTS) return;
    try { sessionStorage.setItem(cacheKey(), JSON.stringify({ at: Date.now(), data })); } catch {}
  }

  function updateNotice(data) {
    if (!data || !active()) return;
    const base = notice.textContent.replace(/・全\d+(?:\.\d+)?放送を開始0分で重ね表示.*$/, '').trim();
    notice.textContent = `${base}・全${number.format(data.event_count || series.length)}放送を開始0分で重ね表示${data.truncated ? '（上限到達）' : ''}`;
  }

  async function loadSeries() {
    if (!active()) return;
    const key = cacheKey();
    if (loadingKey === key) return;
    if (loadedKey === key) {
      draw();
      updateNotice(loadedMeta);
      return;
    }
    loadingKey = key;
    selectedMinute = null;
    try {
      let data = readCache();
      if (!data) {
        controller?.abort();
        controller = new AbortController();
        const params = new URLSearchParams({ from: fromInput.value, to: toInput.value });
        const response = await fetch(`/api/sakurazaka46jp?${params}`, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        data = await response.json();
        if (!response.ok || !data?.ok) throw new Error(data?.error || `API ${response.status}`);
        writeCache(data);
      }
      if (!active()) return;
      series = prepareSeries(data.series);
      loadedKey = key;
      loadedMeta = data;
      draw();
      updateNotice(data);
    } catch (error) {
      if (error?.name !== 'AbortError' && active()) notice.textContent += `・比較グラフ取得失敗: ${error.message}`;
    } finally {
      if (loadingKey === key) loadingKey = '';
    }
  }

  function scheduleLoad(delay = 80) {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      loadTimer = null;
      if (active()) loadSeries();
    }, delay);
  }

  function handlePointer(event) {
    if (!active() || !series.length) return;
    event.stopImmediatePropagation();
    const rect = canvas.getBoundingClientRect();
    const clientX = event.touches?.[0]?.clientX ?? event.clientX;
    const left = Number(canvas.dataset.sakurazakaLeft) || 58;
    const chartWidth = Number(canvas.dataset.sakurazakaWidth) || Math.max(1, rect.width - 76);
    const maxMinute = Number(canvas.dataset.sakurazakaMaxMinute) || 1;
    selectedMinute = Math.max(0, Math.min(maxMinute, (clientX - rect.left - left) / chartWidth * maxMinute));
    draw();
  }

  canvas.addEventListener('click', handlePointer, true);
  canvas.addEventListener('touchstart', handlePointer, { capture: true, passive: true });
  button.addEventListener('click', () => scheduleLoad(120));
  document.getElementById('load')?.addEventListener('click', () => {
    loadedKey = '';
    scheduleLoad(160);
  });
  document.querySelectorAll('.range-presets button').forEach((preset) =>
    preset.addEventListener('click', () => {
      loadedKey = '';
      scheduleLoad(160);
    }));
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (active() && series.length) draw(); }, 260);
  }, { passive: true });
  if (active()) scheduleLoad(0);
})();
