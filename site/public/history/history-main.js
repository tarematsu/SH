const DAY_MS = 86_400_000;
const HISTORY_URL = '/api/dashboard-history';
const VALID_MODES = new Set(['current', 'daily', 'weekly', 'ranking', 'monthly', 'tracks', 'broadcasts']);
const number = new Intl.NumberFormat('ja-JP');
const compact = new Intl.NumberFormat('ja-JP', { notation: 'compact', maximumFractionDigits: 1 });
const detailTime = new Intl.DateTimeFormat('ja-JP', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
const axisTime = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' });

const byId = (id) => document.getElementById(id);
const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const audience = {
  rows: [],
  selected: -1,
  positions: [],
  renderedRows: [],
  loadedAt: 0,
  controller: null,
  resizeTimer: 0,
};

function currentMode() {
  const mode = location.hash.slice(1);
  return VALID_MODES.has(mode) ? mode : 'current';
}

if (!VALID_MODES.has(location.hash.slice(1))) {
  history.replaceState(null, '', '#current');
}

function commentValue(row) {
  for (const value of [row?.comment_velocity, row?.comment_velocity_max, row?.comment_count_delta]) {
    const parsed = finite(value);
    if (parsed != null) return Math.max(0, parsed);
  }
  return 0;
}

function normalizeRows(rows) {
  const cutoff = Date.now() - DAY_MS;
  const keyed = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const observedAt = finite(row?.observed_at);
    if (observedAt == null || observedAt < cutoff) continue;
    keyed.set(observedAt, {
      observed_at: observedAt,
      online_member_count: finite(row.online_member_count),
      comment_velocity: commentValue(row),
    });
  }
  return [...keyed.values()].sort((left, right) => left.observed_at - right.observed_at).slice(-300);
}

function sampleRows(rows, maximum = 180) {
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
      comment_velocity: Math.max(0, ...bucket.map(commentValue)),
    });
  }
  return result;
}

function colors() {
  const css = getComputedStyle(document.documentElement);
  return {
    online: css.getPropertyValue('--accent').trim() || '#d93f79',
    comment: css.getPropertyValue('--green').trim() || '#168b73',
    text: css.getPropertyValue('--text').trim() || '#172033',
    muted: css.getPropertyValue('--muted').trim() || '#667287',
    grid: 'rgba(31,45,68,.11)',
  };
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

function prepareCanvas() {
  const canvas = byId('audienceChart');
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(300, Math.round(bounds.width || 900));
  const height = width < 520 ? 250 : Math.max(270, Math.min(350, Math.round(width * .4)));
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.height = `${height}px`;
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return { canvas, context, width, height };
}

function drawEmpty(message) {
  const { context, width, height } = prepareCanvas();
  context.fillStyle = colors().muted;
  context.font = '13px system-ui';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(message, width / 2, height / 2);
  audience.positions = [];
  audience.renderedRows = [];
}

function drawAudienceChart() {
  if (currentMode() !== 'current') return;
  const rows = sampleRows(normalizeRows(audience.rows));
  if (!rows.length) return drawEmpty('24時間データを読み込み中');

  const { context, width, height } = prepareCanvas();
  const palette = colors();
  const area = { left: 42, right: 45, top: 18, bottom: 36 };
  area.width = width - area.left - area.right;
  area.height = height - area.top - area.bottom;

  const times = rows.map((row) => row.observed_at);
  const firstTime = Math.min(...times);
  const lastTime = Math.max(...times);
  const timeSpan = Math.max(1, lastTime - firstTime);
  const positions = times.map((time) => area.left + area.width * (time - firstTime) / timeSpan);
  const onlineValues = rows.map((row) => finite(row.online_member_count));
  const comments = rows.map(commentValue);
  const onlineScale = scale(onlineValues, 4);
  const commentMax = Math.max(1, ...comments);
  const onlineY = (value) => area.top + area.height - (value - onlineScale.min) * area.height / onlineScale.range;
  const commentY = (value) => area.top + area.height - value * area.height / commentMax;

  context.font = '10.5px system-ui';
  context.textBaseline = 'middle';
  for (let index = 0; index <= 4; index += 1) {
    const y = area.top + area.height * index / 4;
    context.strokeStyle = palette.grid;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(area.left, y);
    context.lineTo(width - area.right, y);
    context.stroke();

    context.fillStyle = palette.online;
    context.textAlign = 'right';
    context.fillText(String(Math.round(onlineScale.max - onlineScale.range * index / 4)), area.left - 7, y);
    context.fillStyle = palette.comment;
    context.textAlign = 'left';
    context.fillText(compact.format(Math.round(commentMax * (1 - index / 4))), width - area.right + 7, y);
  }

  context.fillStyle = palette.comment;
  comments.forEach((value, index) => {
    if (value <= 0) return;
    const gap = index ? Math.max(1, positions[index] - positions[index - 1]) : Math.max(2, area.width / rows.length);
    const barWidth = Math.max(2, Math.min(9, gap * .7));
    context.globalAlpha = .28;
    context.fillRect(positions[index] - barWidth / 2, commentY(value), barWidth, area.top + area.height - commentY(value));
  });
  context.globalAlpha = 1;

  context.strokeStyle = palette.online;
  context.lineWidth = 2.6;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();
  let open = false;
  onlineValues.forEach((value, index) => {
    if (value == null) { open = false; return; }
    const y = onlineY(value);
    if (!open) context.moveTo(positions[index], y);
    else context.lineTo(positions[index], y);
    open = true;
  });
  context.stroke();

  const ticks = width < 480 ? 4 : 6;
  context.fillStyle = palette.muted;
  context.textBaseline = 'top';
  for (let index = 0; index < ticks; index += 1) {
    const ratio = index / Math.max(1, ticks - 1);
    const tickTime = firstTime + timeSpan * ratio;
    const x = area.left + area.width * ratio;
    context.textAlign = index === 0 ? 'left' : index === ticks - 1 ? 'right' : 'center';
    context.fillText(axisTime.format(new Date(tickTime)), x, height - area.bottom + 10);
  }

  if (audience.selected >= 0 && rows[audience.selected]) {
    const selected = rows[audience.selected];
    const x = positions[audience.selected];
    context.save();
    context.strokeStyle = 'rgba(23,32,51,.55)';
    context.setLineDash([4, 4]);
    context.beginPath();
    context.moveTo(x, area.top);
    context.lineTo(x, area.top + area.height);
    context.stroke();
    context.restore();

    const online = finite(selected.online_member_count);
    if (online != null) {
      context.fillStyle = '#fff';
      context.strokeStyle = palette.online;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(x, onlineY(online), 4, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
  }

  const axis = byId('audienceAxis');
  axis.children[0].textContent = detailTime.format(new Date(firstTime));
  axis.children[1].textContent = detailTime.format(new Date(lastTime));
  audience.positions = positions;
  audience.renderedRows = rows;
}

function selectAudiencePoint(event) {
  if (!audience.positions.length) return;
  const bounds = byId('audienceChart').getBoundingClientRect();
  const pointer = event.clientX - bounds.left;
  let selected = 0;
  let distance = Infinity;
  audience.positions.forEach((position, index) => {
    const next = Math.abs(position - pointer);
    if (next < distance) { selected = index; distance = next; }
  });
  audience.selected = selected;
  const row = audience.renderedRows[selected];
  const detail = byId('audienceDetail');
  detail.hidden = false;
  detail.textContent = `${detailTime.format(new Date(row.observed_at))}　オンライン ${number.format(row.online_member_count || 0)}人　コメント勢い ${number.format(commentValue(row))}`;
  drawAudienceChart();
}

async function loadAudience({ force = false } = {}) {
  if (!force && audience.loadedAt && Date.now() - audience.loadedAt < 60_000) {
    drawAudienceChart();
    return;
  }
  audience.controller?.abort();
  const controller = new AbortController();
  audience.controller = controller;
  try {
    const response = await fetch(HISTORY_URL, { signal: controller.signal, headers: { accept: 'application/json' } });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || `API ${response.status}`);
    audience.rows = normalizeRows(payload.history);
    audience.loadedAt = Date.now();
    audience.selected = -1;
    byId('audienceDetail').hidden = true;
    drawAudienceChart();
  } catch (error) {
    if (error?.name !== 'AbortError') drawEmpty('24時間データを取得できませんでした');
  } finally {
    if (audience.controller === controller) audience.controller = null;
  }
}

function syncMode() {
  const isCurrent = currentMode() === 'current';
  byId('audienceChart').hidden = !isCurrent;
  byId('audienceAxis').hidden = !isCurrent;
  byId('audienceLegend').hidden = !isCurrent;
  byId('audienceDetail').hidden = !isCurrent || audience.selected < 0;
  byId('chart').hidden = isCurrent;
  byId('legacyChartAxis').hidden = isCurrent;
  byId('chartLegend').hidden = isCurrent;
  byId('chartDetail').hidden = isCurrent;
  if (isCurrent) {
    byId('chartTitle').textContent = 'オンライン・コメント勢い（24時間）';
    loadAudience();
  }
}

byId('audienceChart').addEventListener('pointerup', selectAudiencePoint);
byId('modeTabs').addEventListener('click', (event) => {
  if (event.target.closest('button[data-mode]')) setTimeout(syncMode, 0);
});
window.addEventListener('hashchange', syncMode);
window.addEventListener('resize', () => {
  clearTimeout(audience.resizeTimer);
  audience.resizeTimer = setTimeout(drawAudienceChart, 150);
}, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) audience.controller?.abort();
  else if (currentMode() === 'current') loadAudience({ force: true });
});

loadAudience();
await import('/history/history-lite.js');
syncMode();
