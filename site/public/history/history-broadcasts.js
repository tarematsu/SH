(() => {
  const broadcastsButton = document.querySelector('[data-mode="broadcasts"]');
  const canvas = document.getElementById('chart');
  const legend = document.getElementById('chartLegend');
  const notice = document.getElementById('notice');
  const fromInput = document.getElementById('from');
  const toInput = document.getElementById('to');
  if (!broadcastsButton || !canvas || !legend || !notice || !fromInput || !toInput) return;

  const CACHE_MS = 15 * 60 * 1000;
  let series = [];
  let selectedMinute = null;
  let abortController = null;
  let resizeTimer = null;
  let loadingKey = '';
  let loadedKey = '';
  let loadedMeta = null;

  const active = () => broadcastsButton.classList.contains('active');
  const number = (value) => Number(value).toLocaleString('ja-JP', { maximumFractionDigits: 1 });

  function elapsedLabel(minutes) {
    const value = Math.max(0, Math.round(Number(minutes) || 0));
    if (value < 60) return `${value}分`;
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    return rest ? `${hours}時間${rest}分` : `${hours}時間`;
  }

  function eventLabel(item) {
    const startedAt = Number(item.started_at);
    if (!Number.isFinite(startedAt)) return item.event_name || '公式ステヘ';
    const date = new Date(startedAt).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
    return `${date} ${item.event_name || '公式ステヘ'}`;
  }

  function colorFor(index, alpha = 1) {
    const hue = (330 + index * 137.508) % 360;
    return `hsla(${hue},72%,72%,${alpha})`;
  }

  function prepareCanvas() {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = canvas.clientWidth || 1000;
    const height = canvas.clientHeight || 330;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  }

  function nearestPoint(points, targetMinute) {
    if (!points?.length) return null;
    let low = 0;
    let high = points.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (Number(points[mid][0]) < targetMinute) low = mid + 1;
      else high = mid;
    }
    const current = points[low];
    const previous = low > 0 ? points[low - 1] : null;
    if (!previous) return current;
    return Math.abs(Number(previous[0]) - targetMinute) <= Math.abs(Number(current[0]) - targetMinute)
      ? previous : current;
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
      `<div><i style="background:${colorFor(index)}"></i><strong>${escapeHtml(eventLabel(item))}</strong><span>${number(point[1])}人</span></div>`).join('')}</div>`;
  }

  function draw() {
    if (!active()) return;
    const { ctx, width, height } = prepareCanvas();
    const available = series.filter((item) => Array.isArray(item.points) && item.points.length);
    const chartTitle = document.getElementById('chartTitle');
    const chartFoot = document.getElementById('chartFoot');
    const startDate = document.getElementById('chartStartDate');
    const endDate = document.getElementById('chartEndDate');
    const guide = document.getElementById('guide');
    if (chartTitle) chartTitle.textContent = '公式ステヘ 同接推移（開始0分比較）';
    if (chartFoot) chartFoot.textContent = '各線は1回の公式ステヘです。横軸は実日時ではなく、各放送の開始からの経過時間です。';
    if (guide) guide.innerHTML = '<strong>公式ステヘ比較</strong><span>全放送の同接推移を、各放送の開始時刻を0分として重ねて表示します。</span>';

    if (!available.length) {
      ctx.fillStyle = '#aaa3b5';
      ctx.font = '14px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('表示できる公式ステヘデータがありません', width / 2, height / 2);
      legend.replaceChildren();
      if (startDate) startDate.textContent = '開始 0分';
      if (endDate) endDate.textContent = '—';
      renderDetail(null);
      return;
    }

    const maxMinute = Math.max(1, ...available.flatMap((item) => item.points.map((point) => Number(point[0]) || 0)));
    const maxListenerRaw = Math.max(1, ...available.flatMap((item) => item.points.map((point) => Number(point[1]) || 0)));
    const maxListener = Math.ceil(maxListenerRaw / 50) * 50;
    const area = { left: 58, right: 18, top: 18, bottom: 42 };
    area.width = Math.max(1, width - area.left - area.right);
    area.height = Math.max(1, height - area.top - area.bottom);
    const xFor = (minute) => area.left + area.width * Math.max(0, Number(minute) || 0) / maxMinute;
    const yFor = (value) => area.top + area.height - area.height * Math.max(0, Number(value) || 0) / maxListener;

    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ffffff18';
    ctx.fillStyle = '#aaa3b5';
    ctx.font = '10.5px system-ui';
    ctx.textBaseline = 'middle';
    for (let index = 0; index <= 4; index += 1) {
      const ratio = index / 4;
      const y = area.top + area.height * ratio;
      ctx.beginPath();
      ctx.moveTo(area.left, y);
      ctx.lineTo(width - area.right, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(number(Math.round(maxListener * (1 - ratio))), area.left - 8, y);
    }

    const tickCount = Math.max(3, Math.min(8, Math.floor(area.width / 90)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let index = 0; index < tickCount; index += 1) {
      const minute = maxMinute * index / Math.max(1, tickCount - 1);
      const x = xFor(minute);
      ctx.strokeStyle = '#ffffff10';
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.top + area.height);
      ctx.stroke();
      ctx.fillStyle = '#aaa3b5';
      ctx.fillText(elapsedLabel(minute), x, height - area.bottom + 11);
    }

    available.forEach((item, index) => {
      ctx.strokeStyle = colorFor(index, available.length > 12 ? 0.68 : 0.9);
      ctx.lineWidth = available.length > 16 ? 1.15 : 1.7;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      let open = false;
      for (const point of item.points) {
        const minute = Number(point[0]);
        const value = Number(point[1]);
        if (!Number.isFinite(minute) || !Number.isFinite(value)) {
          open = false;
          continue;
        }
        const x = xFor(minute);
        const y = yFor(value);
        if (!open) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        open = true;
      }
      ctx.stroke();
    });

    if (selectedMinute != null) {
      const x = xFor(selectedMinute);
      ctx.save();
      ctx.strokeStyle = '#ffffffb0';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.top + area.height);
      ctx.stroke();
      ctx.restore();
    }

    legend.innerHTML = available.map((item, index) =>
      `<span><i style="background:${colorFor(index)}"></i>${escapeHtml(eventLabel(item))}</span>`).join('');
    if (startDate) startDate.textContent = '開始 0分';
    if (endDate) endDate.textContent = `最長 ${elapsedLabel(maxMinute)}`;
    renderDetail(selectedMinute);

    canvas.dataset.broadcastMaxMinute = String(maxMinute);
    canvas.dataset.broadcastLeft = String(area.left);
    canvas.dataset.broadcastWidth = String(area.width);
  }

  function cacheKey() {
    return `broadcast-series:v1:${fromInput.value}:${toInput.value}`;
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
    try { sessionStorage.setItem(cacheKey(), JSON.stringify({ at: Date.now(), data })); } catch {}
  }

  function updateNotice(data) {
    if (!data || !active()) return;
    const base = notice.textContent.replace(/・全\d+(?:\.\d+)?放送を開始0分で重ね表示.*$/, '').trim();
    const truncated = data.truncated ? '（上限到達）' : '';
    const next = `${base}・全${number(data.event_count || series.length)}放送を開始0分で重ね表示${truncated}`;
    if (notice.textContent !== next) notice.textContent = next;
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
        abortController?.abort();
        abortController = new AbortController();
        const params = new URLSearchParams({ from: fromInput.value, to: toInput.value });
        const response = await fetch(`/api/broadcast-series?${params}`, {
          signal: abortController.signal,
          headers: { accept: 'application/json' },
        });
        data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || `API ${response.status}`);
        writeCache(data);
      }
      if (!active()) return;
      series = Array.isArray(data.series) ? data.series : [];
      loadedKey = key;
      loadedMeta = data;
      draw();
      updateNotice(data);
    } catch (error) {
      if (error?.name !== 'AbortError' && active()) {
        const suffix = `・比較グラフ取得失敗: ${error.message}`;
        if (!notice.textContent.includes(suffix)) notice.textContent += suffix;
      }
    } finally {
      if (loadingKey === key) loadingKey = '';
    }
  }

  function scheduleLoad(delay = 80) {
    setTimeout(() => { if (active()) loadSeries(); }, delay);
  }

  function handlePointer(event) {
    if (!active() || !series.length) return;
    event.stopImmediatePropagation();
    const rect = canvas.getBoundingClientRect();
    const clientX = event.touches?.[0]?.clientX ?? event.clientX;
    const left = Number(canvas.dataset.broadcastLeft) || 58;
    const chartWidth = Number(canvas.dataset.broadcastWidth) || Math.max(1, rect.width - 76);
    const maxMinute = Number(canvas.dataset.broadcastMaxMinute) || 1;
    selectedMinute = Math.max(0, Math.min(maxMinute, (clientX - rect.left - left) / chartWidth * maxMinute));
    draw();
  }

  canvas.addEventListener('click', handlePointer, true);
  canvas.addEventListener('touchstart', handlePointer, { capture: true, passive: true });
  broadcastsButton.addEventListener('click', () => scheduleLoad(120));
  document.getElementById('load')?.addEventListener('click', () => {
    loadedKey = '';
    scheduleLoad(160);
  });
  document.querySelectorAll('.range-presets button').forEach((button) =>
    button.addEventListener('click', () => {
      loadedKey = '';
      scheduleLoad(160);
    }));

  new MutationObserver(() => {
    if (active() && !/読み込み中/.test(notice.textContent)) scheduleLoad(30);
  }).observe(notice, { childList: true, characterData: true, subtree: true });

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (active() && series.length) draw(); }, 260);
  }, { passive: true });
})();
