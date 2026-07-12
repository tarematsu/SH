const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const CACHE_MS = 60 * 1000;
const MAX_CHART_POINTS = 240;

let current = [];
let currentMode = 'weekly';
let nextCursor = null;
let loading = false;
let resizeTimer = null;
let chartState = null;
let selectedChartIndex = null;

const MODE_HELP = {
  daily: ['日次集計', '1日ごとの最大同接、再生数増加、メンバー増加を表示します。'],
  weekly: ['週次集計', '週ごとの最大同接、再生数増加、メンバー増加を表示します。'],
  monthly: ['月次集計', '月ごとの長期推移を少ない読み取り量で表示します。'],
  broadcasts: ['公式ステヘ', '過去の公式Stationhead放送を放送単位で表示します。'],
  raw: ['詳細データ', '元の記録を200件ずつ表示します。検索範囲は最大31日です。'],
};

const SUMMARY_LABELS = {
  period_key: '期間', sample_count: '記録数', reliable_sample_count: '有効記録数',
  listener_avg: '平均同接', listener_min: '最小同接', listener_max: '最大同接',
  stream_start: '再生数（開始）', stream_end: '再生数（終了）', stream_growth: '再生数増加',
  member_start: 'メンバー（開始）', member_end: 'メンバー（終了）', member_growth: 'メンバー増加',
  likes_max: '最大いいね', distinct_tracks: '曲数', primary_host: '主なホスト', quality_score: '品質',
};

const BROADCAST_LABELS = {
  event_name: '放送名', started_jst: '開始日時', ended_jst: '終了日時',
  sample_count: '記録数', listener_avg: '平均同接', listener_max: '最大同接',
  likes_max: '最大いいね', distinct_tracks: '曲数', host_handle: 'ホスト',
};

const RAW_LABELS = {
  observed_jst: '取得日時', source_note: '放送名', listener_count: '同接', total_stream_count: '総再生数',
  track_title: '曲名', artist_name: 'アーティスト', likes: 'いいね', comment_velocity: 'コメント勢い', host_handle: 'ホスト',
  total_member_count: 'メンバー', quality_score: '品質',
};

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const fmt = (value) => {
  const number = finiteNumber(value);
  return number == null ? '—' : number.toLocaleString('ja-JP', { maximumFractionDigits: 1 });
};

const escapeHtml = (value) => String(value ?? '—')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

function formatDate(value, includeTime = false) {
  if (!value) return '—';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-');
    return `${year}/${month}/${day}`;
  }
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 100000000000 ? new Date(numeric) : new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date);
}

function shortDate(value, showYear = false) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    return showYear ? `${year}/${month}/${day}` : `${month}/${day}`;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text.slice(0, 10);
  return showYear
    ? `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
    : `${date.getMonth() + 1}/${date.getDate()}`;
}

function rowDate(row) {
  return row?.period_key || row?.started_jst || row?.observed_jst || row?.observed_at || '';
}

const todayJst = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
$('#to').value = todayJst();

function setMode(mode) {
  currentMode = mode;
  selectedChartIndex = null;
  chartState = null;
  $$('.mode-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
  const [title, description] = MODE_HELP[mode];
  $('#guide').innerHTML = `<strong>${title}</strong><span>${description}</span>`;
  $('#metric').hidden = mode === 'broadcasts';
  $('#metric').disabled = mode === 'raw' || mode === 'broadcasts';
  $('#chartPanel').hidden = mode === 'raw';
  $('#chartTitle').textContent = mode === 'broadcasts' ? '公式ステヘ 最大同接推移' : '推移グラフ';
  $('#chartFoot').textContent = mode === 'broadcasts'
    ? '各公式ステヘの最大同接を開始日時順に表示します。'
    : '記録がない期間は線をつながず、空白として表示します。';
  $('#tableTitle').textContent = mode === 'broadcasts' ? '公式ステヘ一覧' : mode === 'raw' ? '詳細データ一覧' : '集計データ一覧';
  resetChartInfo();
}

function applyPreset(days) {
  const to = new Date();
  $('#to').value = todayJst();
  if (days === 'all') $('#from').value = '2024-06-01';
  else {
    const from = new Date(to.getTime() - Number(days) * 86400000);
    $('#from').value = from.toISOString().slice(0, 10);
  }
  $$('.range-presets button').forEach((button) => button.classList.toggle('active', button.dataset.days === String(days)));
}

function sampleRows(rows, max = MAX_CHART_POINTS) {
  if (rows.length <= max) return rows;
  const sampled = [];
  const step = (rows.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) sampled.push(rows[Math.round(i * step)]);
  return sampled;
}

function prepareCanvas() {
  const canvas = $('#chart');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  const width = canvas.clientWidth || 1000;
  const height = canvas.clientHeight || 330;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function resetChartInfo() {
  $('#chartStartDate').textContent = '—';
  $('#chartEndDate').textContent = '—';
  $('#chartDetail').innerHTML = '<span>グラフをタッチまたはクリックすると、その時点の詳細を表示します。</span>';
}

function setChartRange(dates) {
  const valid = dates.filter(Boolean);
  $('#chartStartDate').textContent = valid.length ? formatDate(valid[0]) : '—';
  $('#chartEndDate').textContent = valid.length ? formatDate(valid.at(-1)) : '—';
}

function dateTimestamp(value) {
  const text = String(value || '');
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function makeXPositions(dates, area) {
  const times = dates.map(dateTimestamp);
  const valid = times.filter((value) => value != null);
  if (valid.length >= 2) {
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const span = max - min;
    if (span > 0) {
      return times.map((time, index) => time == null
        ? area.left + area.width * index / Math.max(1, dates.length - 1)
        : area.left + area.width * (time - min) / span);
    }
  }
  return dates.map((_, index) => area.left + area.width * index / Math.max(1, dates.length - 1));
}

function isTemporalGap(previousDate, currentDate, mode) {
  const previous = dateTimestamp(previousDate);
  const current = dateTimestamp(currentDate);
  if (previous == null || current == null) return false;
  const days = Math.abs(current - previous) / 86400000;
  const threshold = mode === 'daily' ? 1.5 : mode === 'monthly' ? 45 : mode === 'broadcasts' ? 240 : 10;
  return days > threshold;
}

function drawGrid(ctx, width, height, area) {
  ctx.strokeStyle = '#ffffff18';
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const y = area.top + area.height * i / 4;
    ctx.beginPath();
    ctx.moveTo(area.left, y);
    ctx.lineTo(width - area.right, y);
    ctx.stroke();
  }
  ctx.strokeStyle = '#ffffff24';
  ctx.beginPath();
  ctx.moveTo(area.left, height - area.bottom);
  ctx.lineTo(width - area.right, height - area.bottom);
  ctx.stroke();
}

function drawDateAxis(ctx, dates, xPositions, width, height, area) {
  if (!dates.length) return;
  const firstTs = dateTimestamp(dates[0]);
  const lastTs = dateTimestamp(dates.at(-1));
  const spanDays = firstTs != null && lastTs != null ? Math.abs(lastTs - firstTs) / 86400000 : 0;
  const labelFor = (value) => {
    const text = String(value || '');
    if (currentMode === 'monthly') return text.slice(0, 7).replace('-', '/');
    if (spanDays > 730) return text.slice(0, 7).replace('-', '/');
    if (spanDays > 120) return shortDate(value, true).slice(2);
    return shortDate(value, spanDays > 300);
  };
  const estimatedLabelWidth = currentMode === 'monthly' || spanDays > 120 ? 54 : 42;
  const desired = Math.max(2, Math.min(dates.length, Math.floor(area.width / (estimatedLabelWidth + 14))));
  const indices = [...new Set(Array.from({ length: desired }, (_, i) =>
    Math.round((dates.length - 1) * i / Math.max(1, desired - 1))))];
  ctx.font = '10.5px system-ui';
  ctx.fillStyle = '#aaa3b5';
  ctx.textBaseline = 'top';
  let lastRight = -Infinity;
  indices.forEach((index, position) => {
    const text = labelFor(dates[index]);
    const measured = ctx.measureText(text).width;
    const x = Math.max(area.left, Math.min(width - area.right - measured, xPositions[index] - measured / 2));
    const isLast = position === indices.length - 1;
    if (x > lastRight + 7 || isLast) {
      ctx.fillText(text, x, height - area.bottom + 11);
      lastRight = x + measured;
    }
  });
}

function drawSelection(ctx, x, area) {
  if (!Number.isFinite(x)) return;
  ctx.save();
  ctx.strokeStyle = '#ffffff70';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x, area.top);
  ctx.lineTo(x, area.top + area.height);
  ctx.stroke();
  ctx.restore();
}

function drawEmpty(ctx, width, height, message = '表示できるデータがありません') {
  ctx.fillStyle = '#aaa3b5';
  ctx.font = '14px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, width / 2, height / 2);
  chartState = null;
  resetChartInfo();
}

function draw(rows, metric, selectedIndex = null) {
  const { ctx, width, height } = prepareCanvas();
  const sorted = [...rows].sort((a, b) => (dateTimestamp(rowDate(a)) ?? 0) - (dateTimestamp(rowDate(b)) ?? 0));
  const sampled = sampleRows(sorted);
  const points = sampled.map((row) => ({ row, date: rowDate(row), value: finiteNumber(row[metric]) }));
  const validValues = points.map((point) => point.value).filter((value) => value != null);
  if (!points.length || !validValues.length) {
    drawEmpty(ctx, width, height);
    return;
  }
  const area = { left: 58, right: 18, top: 18, bottom: 42 };
  area.width = Math.max(1, width - area.left - area.right);
  area.height = Math.max(1, height - area.top - area.bottom);
  drawGrid(ctx, width, height, area);
  const min = Math.min(...validValues);
  const max = Math.max(...validValues);
  const range = max - min || 1;
  const dates = points.map((point) => point.date);
  const xPositions = makeXPositions(dates, area);
  const yFor = (value) => area.top + area.height - ((value - min) / range) * area.height;
  ctx.font = '10.5px system-ui';
  ctx.fillStyle = '#aaa3b5';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 5; i++) {
    const value = max - range * i / 4;
    const y = area.top + area.height * i / 4;
    ctx.fillText(fmt(value), area.left - 8, y);
  }
  drawDateAxis(ctx, dates, xPositions, width, height, area);
  ctx.strokeStyle = '#f6c7d9';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let open = false;
  points.forEach((point, index) => {
    if (point.value == null) {
      open = false;
      return;
    }
    const x = xPositions[index];
    const y = yFor(point.value);
    const gap = index > 0 && isTemporalGap(points[index - 1].date, point.date, currentMode);
    if (!open || gap) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    open = true;
  });
  ctx.stroke();
  points.forEach((point, index) => {
    if (point.value == null) return;
    const x = xPositions[index];
    const y = yFor(point.value);
    ctx.fillStyle = '#f6c7d9';
    ctx.beginPath();
    ctx.arc(x, y, 2.8, 0, Math.PI * 2);
    ctx.fill();
  });
  const selected = Number.isInteger(selectedIndex) && points[selectedIndex] ? selectedIndex : null;
  if (selected != null) drawSelection(ctx, xPositions[selected], area);
  chartState = { type: 'series', points, xPositions, metric, selectedIndex: selected };
  setChartRange(dates);
  if (selected != null) renderSeriesDetail(points[selected], metric);
}

function renderSeriesDetail(point, metric) {
  if (!point) return;
  const label = currentMode === 'broadcasts' ? point.row.event_name || '公式ステヘ' : SUMMARY_LABELS[metric] || metric;
  $('#chartDetail').innerHTML = `<time>${escapeHtml(formatDate(point.date, currentMode === 'broadcasts'))}</time><div class="chart-detail-values"><div><strong>${escapeHtml(label)}</strong><span>${fmt(point.value)}</span></div></div>`;
}

function nearestIndex(xs, x) {
  if (!xs?.length) return null;
  let best = 0;
  let distance = Infinity;
  xs.forEach((value, index) => {
    const next = Math.abs(value - x);
    if (next < distance) {
      distance = next;
      best = index;
    }
  });
  return best;
}

function handleChartPointer(event) {
  if (!chartState) return;
  const canvas = $('#chart');
  const rect = canvas.getBoundingClientRect();
  const clientX = event.touches?.[0]?.clientX ?? event.clientX;
  const index = nearestIndex(chartState.xPositions, clientX - rect.left);
  if (index == null) return;
  selectedChartIndex = index;
  draw(current, chartState.metric, index);
}

$('#chart').addEventListener('click', handleChartPointer);
$('#chart').addEventListener('touchstart', handleChartPointer, { passive: true });

function visibleKeys(mode) {
  if (mode === 'broadcasts') return Object.keys(BROADCAST_LABELS);
  if (mode === 'raw') return Object.keys(RAW_LABELS);
  return Object.keys(SUMMARY_LABELS);
}

function labelsFor(mode) {
  if (mode === 'broadcasts') return BROADCAST_LABELS;
  if (mode === 'raw') return RAW_LABELS;
  return SUMMARY_LABELS;
}

function displayCell(key, row, mode) {
  const value = row[key];
  if (key.includes('date') || key.includes('jst') || key === 'period_key') return formatDate(value, key.includes('jst'));
  if (typeof value === 'number') return fmt(value);
  return value == null || value === '' ? '—' : String(value);
}

function renderTable(rows, mode, append = false) {
  const keys = visibleKeys(mode);
  const labels = labelsFor(mode);
  if (!append) {
    $('#thead').innerHTML = `<tr>${keys.map((key) => `<th>${escapeHtml(labels[key] || key)}</th>`).join('')}</tr>`;
    $('#tbody').innerHTML = '';
  }
  const html = rows.map((row) => `<tr>${keys.map((key) => {
    return `<td>${escapeHtml(displayCell(key, row, mode))}</td>`;
  }).join('')}</tr>`).join('');
  $('#tbody').insertAdjacentHTML('beforeend', html);
}

function updateSummary(rows, mode) {
  $('#periodLabel').textContent = mode === 'broadcasts' ? '放送数' : mode === 'raw' ? '表示件数' : '期間数';
  $('#maxLabel').textContent = '最大同接';
  $('#streamLabel').textContent = '再生数増加';
  $('#memberLabel').textContent = 'メンバー増加';
  $('#periods').textContent = fmt(rows.length);
  const listeners = rows.map((row) => finiteNumber(row.listener_max ?? row.listener_count)).filter((value) => value != null);
  const streamGrowth = rows.reduce((sum, row) => sum + (finiteNumber(row.stream_growth) || 0), 0);
  const memberGrowth = rows.reduce((sum, row) => sum + (finiteNumber(row.member_growth) || 0), 0);
  $('#maxListener').textContent = listeners.length ? fmt(Math.max(...listeners)) : '—';
  $('#streamGrowth').textContent = mode === 'raw' || mode === 'broadcasts' ? '—' : fmt(streamGrowth);
  $('#memberGrowth').textContent = mode === 'raw' || mode === 'broadcasts' ? '—' : fmt(memberGrowth);
}

function withDailyTotals(rows) {
  const totals = new Map();
  for (const row of rows) {
    totals.set(row.play_date, (totals.get(row.play_date) || 0) + (finiteNumber(row.play_count) || 0));
  }
  const result = [];
  let previousDate = null;
  for (const row of rows) {
    const total = totals.get(row.play_date) || 0;
    if (row.play_date !== previousDate) {
      result.push({
        _daily_total: true,
        play_date: row.play_date,
        title: 'この日の延べ曲数',
        artist: '—',
        play_count: total,
        daily_share: 100,
        like_count: null,
        first_played_at: null,
        last_played_at: null,
      });
      previousDate = row.play_date;
    }
    result.push({
      ...row,
      daily_share: total > 0 ? (finiteNumber(row.play_count) || 0) / total * 100 : 0,
    });
  }
  return result;
}

function cacheKey(mode, from, to, extra = '') { return `history:v9:${mode}:${from}:${to}:${extra}`; }

function readCache(key) {
  try {
    const cached = JSON.parse(sessionStorage.getItem(key));
    if (!cached || Date.now() - cached.at > CACHE_MS) return null;
    return cached.data;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch {}
}

async function load({ append = false } = {}) {
  if (loading) return;
  loading = true;
  selectedChartIndex = null;
  const mode = currentMode;
  const from = $('#from').value;
  const to = $('#to').value;
  const key = cacheKey(mode, from, to);
  $('#notice').textContent = append ? '続きを読み込み中…' : '読み込み中…';
  try {
    let data = !append && mode !== 'raw' ? readCache(key) : null;
    if (!data) {
      const params = new URLSearchParams({ mode, from, to, v: '9' });
      if (mode === 'raw') {
        params.set('limit', '200');
        if (append && nextCursor) params.set('cursor', nextCursor);
      }
      const response = await fetch(`/api/history?${params}`, { cache: 'no-store' });
      data = await response.json();
      if (!data.ok) throw new Error(data.error);
      if (!append && mode !== 'raw') writeCache(key, data);
    }
    if (append) current.push(...(data.rows || []));
    else current = data.rows || [];
    nextCursor = data.next_cursor || null;
    updateSummary(current, mode);
    renderTable(data.rows || [], mode, append);
    $('#more').hidden = mode !== 'raw' || !data.has_more;
    $('#chartPanel').hidden = mode === 'raw';
    if (mode !== 'raw') draw(current, mode === 'broadcasts' ? 'listener_max' : $('#metric').value);
    $('#chartDetail').innerHTML = '<span>グラフをタッチまたはクリックすると、その時点の詳細を表示します。</span>';
    if (mode === 'broadcasts' && data.setup_required) {
      $('#notice').textContent = '公式ステヘのD1データが未登録です。';
    } else if (mode === 'broadcasts') {
      const importedRows = data.diagnostic?.imported_rows;
      const suffix = importedRows != null ? `（D1登録 ${fmt(importedRows)}行）` : '';
      $('#notice').textContent = `${fmt(current.length)}件の公式ステヘを表示${suffix}`;
    } else if (mode === 'raw') {
      $('#notice').textContent = `${fmt(current.length)}件を表示中（200件ずつ取得）`;
    } else {
      const liveText = data.live_overlay_count ? `・最新Collectorデータ ${fmt(data.live_overlay_count)}期間を反映` : '';
      const latestText = data.latest_live_observed_at ? `（最終 ${formatDate(data.latest_live_observed_at, true)}）` : '';
      $('#notice').textContent = `${fmt(current.length)}期間を表示${liveText}${latestText}`;
    }
  } catch (error) {
    $('#notice').textContent = `API error: ${error.message}`;
  } finally {
    loading = false;
  }
}

$$('.mode-tabs button').forEach((button) => {
  button.onclick = () => {
    nextCursor = null;
    setMode(button.dataset.mode);
    load();
  };
});
$$('.range-presets button').forEach((button) => {
  button.onclick = () => {
    applyPreset(button.dataset.days);
    nextCursor = null;
    load();
  };
});
$('#load').onclick = () => { nextCursor = null; load(); };
$('#more').onclick = () => load({ append: true });
$('#metric').onchange = () => {
  draw(current, currentMode === 'broadcasts' ? 'listener_max' : $('#metric').value, selectedChartIndex);
};
$('#csv').onclick = () => {
  const keys = visibleKeys(currentMode);
  const labels = labelsFor(currentMode);
  const lines = [keys.map((key) => labels[key] || key), ...current.map((row) => keys.map((key) => row[key] ?? ''))]
    .map((line) => line.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','));
  const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `sh-${currentMode}-${todayJst()}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
};
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (currentMode !== 'raw') draw(current, currentMode === 'broadcasts' ? 'listener_max' : $('#metric').value, selectedChartIndex);
  }, 160);
});
setMode('weekly');
