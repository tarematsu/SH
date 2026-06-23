const $ = (selector) => document.querySelector(selector);
const CACHE_MS = 10 * 60 * 1000;
const MAX_CHART_POINTS = 240;
let current = [];
let currentMode = 'weekly';
let nextCursor = null;
let loading = false;
let resizeTimer = null;

const fmt = (value) => value == null || value === ''
  ? '—'
  : Number(value).toLocaleString('ja-JP', { maximumFractionDigits: 1 });

$('#to').value = new Date().toISOString().slice(0, 10);

function sampleRows(rows, max = MAX_CHART_POINTS) {
  if (rows.length <= max) return rows;
  const sampled = [];
  const step = (rows.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) sampled.push(rows[Math.round(i * step)]);
  return sampled;
}

function draw(rows, key) {
  const canvas = $('#chart');
  const ctx = canvas.getContext('2d');
  const source = sampleRows(rows);
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  const width = canvas.clientWidth || 1000;
  const height = canvas.clientHeight || 330;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const points = source.map((row, index) => ({ x: index, y: Number(row[key]) }))
    .filter((point) => Number.isFinite(point.y));
  if (points.length < 2) {
    ctx.fillStyle = '#aaa3b5';
    ctx.fillText('表示できるデータが不足しています', 20, 30);
    return;
  }

  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    if (point.y < min) min = point.y;
    if (point.y > max) max = point.y;
  }

  const padding = 28;
  const span = max - min || 1;
  ctx.strokeStyle = '#ffffff18';
  for (let i = 0; i < 5; i++) {
    const y = padding + (height - padding * 2) * i / 4;
    ctx.beginPath(); ctx.moveTo(padding, y); ctx.lineTo(width - padding, y); ctx.stroke();
  }

  ctx.strokeStyle = '#f6c7d9';
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = padding + (width - padding * 2) * (point.x / (source.length - 1 || 1));
    const y = height - padding - (point.y - min) / span * (height - padding * 2);
    index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#aaa3b5';
  ctx.font = '11px system-ui';
  ctx.fillText(fmt(max), 4, 14);
  ctx.fillText(fmt(min), 4, height - 8);
}

function renderTable(rows, mode, append = false) {
  const raw = mode === 'raw';
  const columns = raw
    ? ['observed_jst','listener_count','total_stream_count','track_title','artist_name','host_handle','total_member_count','quality_score']
    : ['period_key','sample_count','listener_avg','listener_max','stream_growth','member_growth','stream_end','member_end','primary_host','quality_score'];

  if (!append) {
    $('#thead').innerHTML = `<tr>${columns.map((column) => `<th>${column}</th>`).join('')}</tr>`;
    $('#tbody').innerHTML = '';
  }

  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = columns.map((column) =>
      `<td>${typeof row[column] === 'number' ? fmt(row[column]) : (row[column] ?? '—')}</td>`
    ).join('');
    fragment.appendChild(tr);
  }
  $('#tbody').appendChild(fragment);
}

function updateSummary(rows, mode) {
  $('#periods').textContent = fmt(rows.length);
  let maxListener = 0;
  let streamGrowth = 0;
  let memberGrowth = 0;
  for (const row of rows) {
    const listener = Number(row.listener_max ?? row.listener_count);
    if (Number.isFinite(listener) && listener > maxListener) maxListener = listener;
    streamGrowth += Number(row.stream_growth) || 0;
    memberGrowth += Number(row.member_growth) || 0;
  }
  $('#maxListener').textContent = fmt(maxListener);
  $('#streamGrowth').textContent = mode === 'raw' ? '—' : fmt(streamGrowth);
  $('#memberGrowth').textContent = mode === 'raw' ? '—' : fmt(memberGrowth);
}

function cacheKey(mode, from, to) { return `history:v2:${mode}:${from}:${to}`; }
function readCache(key) {
  try {
    const entry = JSON.parse(sessionStorage.getItem(key));
    if (entry && Date.now() - entry.savedAt < CACHE_MS) return entry.data;
  } catch {}
  return null;
}
function writeCache(key, data) {
  try { sessionStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data })); } catch {}
}

async function load({ append = false } = {}) {
  if (loading) return;
  loading = true;
  const mode = $('#mode').value;
  const from = $('#from').value;
  const to = $('#to').value;
  const key = cacheKey(mode, from, to);
  $('#notice').textContent = append ? '続きを読み込み中…' : '読み込み中…';

  try {
    let data = !append && mode !== 'raw' ? readCache(key) : null;
    if (!data) {
      const params = new URLSearchParams({ mode, from, to });
      if (mode === 'raw') {
        params.set('limit', '200');
        if (append && nextCursor) params.set('cursor', nextCursor);
      }
      const response = await fetch(`/api/history?${params}`, { cache: mode === 'raw' ? 'no-store' : 'default' });
      data = await response.json();
      if (!data.ok) throw new Error(data.error);
      if (!append && mode !== 'raw') writeCache(key, data);
    }

    currentMode = mode;
    if (append) current.push(...(data.rows || []));
    else current = data.rows || [];
    nextCursor = data.next_cursor || null;

    updateSummary(current, mode);
    renderTable(data.rows || [], mode, append);
    $('#chartPanel').hidden = mode === 'raw';
    if (mode !== 'raw') draw(current, $('#metric').value);
    $('#more').hidden = mode !== 'raw' || !data.has_more;
    $('#notice').textContent = mode === 'raw'
      ? `${fmt(current.length)}件を表示中（詳細は200件ずつ取得）`
      : `${fmt(current.length)}期間を集計済みデータから表示`;
  } catch (error) {
    $('#notice').textContent = `API error: ${error.message}`;
  } finally {
    loading = false;
  }
}

$('#load').onclick = () => { nextCursor = null; load(); };
$('#more').onclick = () => load({ append: true });
$('#metric').onchange = () => draw(current, $('#metric').value);
$('#mode').onchange = () => {
  const raw = $('#mode').value === 'raw';
  $('#metric').disabled = raw;
  nextCursor = null;
  load();
};
$('#csv').onclick = () => {
  if (!current.length) return;
  const columns = Object.keys(current[0]);
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const csv = [columns.join(','), ...current.map((row) => columns.map((column) => escape(row[column])).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `buddies-history-${currentMode}.csv`; a.click();
  URL.revokeObjectURL(url);
};
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (currentMode !== 'raw') draw(current, $('#metric').value); }, 180);
});

load();
