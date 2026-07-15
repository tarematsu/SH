const HISTORY_LIMIT = 300;
const DAY_MS = 86_400_000;
const CACHE_KEY = 'sh.dashboard-lite.v1';
const originalFetch = window.fetch.bind(window);
const integer = new Intl.NumberFormat('ja-JP');
const compact = new Intl.NumberFormat('ja-JP', { notation: 'compact', maximumFractionDigits: 1 });
const dateTime = new Intl.DateTimeFormat('ja-JP', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

const chartState = {
  history: [],
  selected: -1,
  renderedRows: [],
  x: [],
  resizeTimer: 0,
};

const byId = (id) => document.getElementById(id);
const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const formatNumber = (value) => finite(value) == null ? '—' : integer.format(Number(value));

function chartComment(row) {
  for (const candidate of [row?.comment_velocity, row?.comment_velocity_max, row?.comment_count_delta]) {
    const value = finite(candidate);
    if (value != null) return Math.max(0, value);
  }
  return 0;
}

function normalizeHistory(rows) {
  const cutoff = Date.now() - DAY_MS;
  const byTime = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const observedAt = finite(row?.observed_at);
    if (observedAt == null || observedAt < cutoff) continue;
    byTime.set(observedAt, {
      observed_at: observedAt,
      online_member_count: finite(row.online_member_count),
      comment_velocity: chartComment(row),
    });
  }
  return [...byTime.values()]
    .sort((left, right) => left.observed_at - right.observed_at)
    .slice(-HISTORY_LIMIT);
}

function mergeLatest(payload) {
  const latest = payload?.latest || {};
  const observedAt = finite(latest.observed_at);
  if (observedAt == null) return;
  chartState.history = normalizeHistory([
    ...chartState.history,
    {
      observed_at: observedAt,
      online_member_count: finite(latest.online_member_count),
      comment_velocity: chartComment(latest),
    },
  ]);
  drawChart();
}

function replaceHistory(rows) {
  chartState.history = normalizeHistory(rows);
  chartState.selected = -1;
  drawChart();
}

function restoreHistoryCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!cached || Date.now() - Number(cached.savedAt || 0) > 6 * 60 * 60 * 1000) return;
    chartState.history = normalizeHistory(cached.history);
    if (cached.payload?.latest) mergeLatest(cached.payload);
  } catch {
    // The live dashboard still loads when browser storage is unavailable.
  }
}

async function captureResponse(url, response) {
  if (!response.ok) return;
  const pathname = new URL(url, location.href).pathname;
  if (pathname !== '/api/dashboard' && pathname !== '/api/dashboard-history') return;
  try {
    const payload = await response.clone().json();
    if (!payload?.ok) return;
    if (pathname === '/api/dashboard-history') replaceHistory(payload.history);
    else mergeLatest(payload);
  } catch {
    // The primary client owns request error reporting.
  }
}

window.fetch = async (input, init) => {
  const response = await originalFetch(input, init);
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
  if (url) captureResponse(url, response);
  return response;
};

function setupStaticImage(imageId, fallbackId) {
  const image = byId(imageId);
  const fallback = byId(fallbackId);
  if (!image || !fallback) return;

  const pending = () => {
    image.classList.remove('is-loaded');
    fallback.hidden = false;
  };
  const loaded = () => {
    image.hidden = false;
    image.classList.add('is-loaded');
    fallback.hidden = true;
  };
  const failed = () => {
    image.classList.remove('is-loaded');
    image.hidden = true;
    image.removeAttribute('src');
    fallback.hidden = false;
  };

  image.addEventListener('load', loaded);
  image.addEventListener('error', failed);
  new MutationObserver((records) => {
    if (records.some((record) => record.attributeName === 'src')) pending();
  }).observe(image, { attributes: true, attributeFilter: ['src'] });
}

function normalizeQueueImage(image) {
  if (!(image instanceof HTMLImageElement) || !image.classList.contains('queue-thumb')) return;
  if (image.dataset.fallbackBound === '1') return;
  image.dataset.fallbackBound = '1';
  const missing = () => {
    image.hidden = false;
    image.removeAttribute('src');
    image.classList.add('image-missing');
  };
  image.addEventListener('load', () => image.classList.remove('image-missing'));
  image.addEventListener('error', missing);
  if (image.hidden || !image.getAttribute('src')) missing();
}

function observeQueueImages() {
  const queue = byId('queue');
  if (!queue) return;
  const inspect = (root) => {
    if (root instanceof HTMLImageElement) normalizeQueueImage(root);
    root.querySelectorAll?.('img.queue-thumb').forEach(normalizeQueueImage);
  };
  inspect(queue);
  new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach(inspect);
  }).observe(queue, { childList: true, subtree: true });
}

function reducedRows(rows, maximum = 150) {
  if (rows.length <= maximum) return rows;
  const bucketSize = rows.length / maximum;
  const result = [];
  for (let index = 0; index < maximum; index += 1) {
    const start = Math.floor(index * bucketSize);
    const end = Math.max(start + 1, Math.floor((index + 1) * bucketSize));
    const bucket = rows.slice(start, end);
    const last = bucket.at(-1);
    if (!last) continue;
    result.push({
      ...last,
      comment_velocity: Math.max(0, ...bucket.map(chartComment)),
    });
  }
  return result;
}

function scale(values, minimumPadding = 1) {
  const valid = values.filter((value) => value != null);
  if (!valid.length) return { min: 0, max: 1, range: 1 };
  const rawMin = Math.min(...valid);
  const rawMax = Math.max(...valid);
  const padding = Math.max(minimumPadding, (rawMax - rawMin) * .1);
  const min = Math.max(0, rawMin - padding);
  const max = rawMax + padding;
  return { min, max, range: Math.max(1, max - min) };
}

function chartColors() {
  const css = getComputedStyle(document.documentElement);
  return {
    online: css.getPropertyValue('--accent').trim() || '#d93f79',
    comment: css.getPropertyValue('--comment').trim() || '#168b73',
    muted: css.getPropertyValue('--muted').trim() || '#667287',
    text: css.getPropertyValue('--text').trim() || '#172033',
    grid: 'rgba(31,45,68,.11)',
  };
}

function drawEmpty(context, width, height, message) {
  context.fillStyle = chartColors().muted;
  context.font = '13px system-ui';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(message, width / 2, height / 2);
  chartState.renderedRows = [];
  chartState.x = [];
}

function drawChart() {
  const canvas = byId('audienceChart');
  if (!canvas) return;
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(300, Math.round(bounds.width || 900));
  const height = width < 520 ? 260 : Math.max(270, Math.min(360, Math.round(width * .42)));
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.height = `${height}px`;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const rows = reducedRows(normalizeHistory(chartState.history));
  if (!rows.length) {
    drawEmpty(context, width, height, '履歴データを読み込み中です。');
    return;
  }

  const colors = chartColors();
  const padding = { left: 42, right: 46, top: 18, bottom: 38 };
  const plotWidth = Math.max(1, width - padding.left - padding.right);
  const plotHeight = Math.max(1, height - padding.top - padding.bottom);
  const times = rows.map((row) => Number(row.observed_at));
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const span = Math.max(1, maxTime - minTime);
  const x = times.map((time) => padding.left + plotWidth * (time - minTime) / span);
  const onlineValues = rows.map((row) => finite(row.online_member_count));
  const comments = rows.map(chartComment);
  const onlineScale = scale(onlineValues, 4);
  const commentMax = Math.max(1, ...comments);
  const yOnline = (value) => padding.top + plotHeight - (value - onlineScale.min) * plotHeight / onlineScale.range;
  const yComment = (value) => padding.top + plotHeight - value * plotHeight / commentMax;

  context.font = '11px system-ui';
  context.lineWidth = 1;
  context.textBaseline = 'middle';
  for (let index = 0; index <= 4; index += 1) {
    const vertical = padding.top + plotHeight * index / 4;
    context.strokeStyle = colors.grid;
    context.beginPath();
    context.moveTo(padding.left, vertical);
    context.lineTo(width - padding.right, vertical);
    context.stroke();

    context.fillStyle = colors.online;
    context.textAlign = 'right';
    context.fillText(String(Math.round(onlineScale.max - onlineScale.range * index / 4)), padding.left - 7, vertical);
    context.fillStyle = colors.comment;
    context.textAlign = 'left';
    context.fillText(compact.format(Math.round(commentMax * (1 - index / 4))), width - padding.right + 7, vertical);
  }

  context.fillStyle = colors.comment;
  comments.forEach((value, index) => {
    if (value <= 0) return;
    const gap = index > 0 ? Math.max(1, x[index] - x[index - 1]) : Math.max(2, plotWidth / rows.length);
    const barWidth = Math.max(2, Math.min(10, gap * .72));
    context.globalAlpha = .28;
    context.fillRect(x[index] - barWidth / 2, yComment(value), barWidth, padding.top + plotHeight - yComment(value));
  });
  context.globalAlpha = 1;

  context.beginPath();
  context.strokeStyle = colors.online;
  context.lineWidth = 2.6;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  let started = false;
  rows.forEach((row, index) => {
    const value = finite(row.online_member_count);
    if (value == null) {
      started = false;
      return;
    }
    const pointY = yOnline(value);
    if (!started) context.moveTo(x[index], pointY);
    else context.lineTo(x[index], pointY);
    started = true;
  });
  context.stroke();

  const tickCount = width < 480 ? 4 : 6;
  context.fillStyle = colors.muted;
  context.textBaseline = 'top';
  for (let index = 0; index < tickCount; index += 1) {
    const ratioAtTick = index / Math.max(1, tickCount - 1);
    const tickTime = minTime + span * ratioAtTick;
    const label = new Date(tickTime).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const pointX = padding.left + plotWidth * ratioAtTick;
    context.textAlign = index === 0 ? 'left' : index === tickCount - 1 ? 'right' : 'center';
    context.fillText(label, pointX, height - padding.bottom + 11);
  }

  if (chartState.selected >= 0 && chartState.selected < rows.length) {
    const selectedX = x[chartState.selected];
    const selected = rows[chartState.selected];
    context.save();
    context.strokeStyle = 'rgba(23,32,51,.55)';
    context.setLineDash([4, 4]);
    context.beginPath();
    context.moveTo(selectedX, padding.top);
    context.lineTo(selectedX, padding.top + plotHeight);
    context.stroke();
    context.restore();

    const online = finite(selected.online_member_count);
    if (online != null) {
      context.fillStyle = '#fff';
      context.strokeStyle = colors.online;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(selectedX, yOnline(online), 4, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
  }

  chartState.renderedRows = rows;
  chartState.x = x;
}

function selectChartPoint(event) {
  if (!chartState.x.length) return;
  const canvas = byId('audienceChart');
  const bounds = canvas.getBoundingClientRect();
  const pointer = event.clientX - bounds.left;
  let selected = 0;
  let distance = Infinity;
  chartState.x.forEach((point, index) => {
    const next = Math.abs(point - pointer);
    if (next < distance) {
      distance = next;
      selected = index;
    }
  });
  chartState.selected = selected;
  const row = chartState.renderedRows[selected];
  const detail = byId('chartDetail');
  if (detail && row) {
    detail.textContent = `${dateTime.format(new Date(row.observed_at))}　オンライン ${formatNumber(row.online_member_count)}人　コメント勢い ${formatNumber(chartComment(row))}件 / 2分`;
  }
  drawChart();
}

setupStaticImage('channelImage', 'channelFallback');
setupStaticImage('trackImage', 'trackFallback');
observeQueueImages();
restoreHistoryCache();
byId('audienceChart')?.addEventListener('pointerup', selectChartPoint);
window.addEventListener('resize', () => {
  clearTimeout(chartState.resizeTimer);
  chartState.resizeTimer = setTimeout(drawChart, 150);
}, { passive: true });
requestAnimationFrame(drawChart);

import('/app-lite.js').catch((error) => {
  console.error('dashboard client failed to start', error);
  const status = byId('statusMessage');
  if (status) {
    status.textContent = '画面の初期化に失敗しました。再読み込みしてください。';
    status.hidden = false;
  }
});
