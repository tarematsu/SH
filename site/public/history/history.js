const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const CACHE_MS = 10 * 60 * 1000;
const MAX_CHART_POINTS = 240;
const FEATURED_HOSTS = ['sakuramankai', 'sakurazaka46jp'];

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
  raw: ['詳細データ', '元の記録を200件ずつ表示します。検索範囲は最大31日です。'],
  ranking: ['週間リーダーボード', 'Stationheadで放送しているホストの週次順位です。掲載がない週は「圏外」として表示します。'],
};

const SUMMARY_LABELS = {
  period_key: '期間', sample_count: '記録数', reliable_sample_count: '有効記録数',
  listener_avg: '平均同接', listener_min: '最小同接', listener_max: '最大同接',
  stream_start: '再生数（開始）', stream_end: '再生数（終了）', stream_growth: '再生数増加',
  member_start: 'メンバー（開始）', member_end: 'メンバー（終了）', member_growth: 'メンバー増加',
  likes_max: '最大いいね', distinct_tracks: '曲数', primary_host: '主なホスト', quality_score: '品質',
};

const RAW_LABELS = {
  observed_jst: '取得日時', listener_count: '同接', total_stream_count: '総再生数',
  track_title: '曲名', artist_name: 'アーティスト', host_handle: 'ホスト',
  total_member_count: 'メンバー', quality_score: '品質',
};

const RANKING_LABELS = {
  ranking_date: '週', host_name: 'ホスト', rank: '順位', previous_rank: '前週順位',
  rank_change: '前週比', source_sheet: '順位データ出典', quality_score: '品質',
};

const WEEKLY_METRIC_LABELS = {
  ranking_date: '週', stream_growth: '週間再生数', member_growth: '週間メンバー増加',
  listener_avg: '平均同接', listener_min: '最小同接', listener_max: '最大同接',
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
  const date = new Date(text);
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
  return row?.ranking_date || row?.period_key || row?.observed_jst || row?.observed_at || '';
}

$('#to').value = new Date().toISOString().slice(0, 10);

function setMode(mode) {
  currentMode = mode;
  selectedChartIndex = null;
  chartState = null;
  $$('.mode-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
  const [title, description] = MODE_HELP[mode];
  $('#guide').innerHTML = `<strong>${title}</strong><span>${description}</span>`;
  const ranking = mode === 'ranking';
  $('#rankingScopeWrap').hidden = !ranking;
  $('#hostWrap').hidden = !ranking;
  $('#rankingWeeklyPanel').hidden = !ranking;
  $('#metric').hidden = ranking;
  $('#metric').disabled = mode === 'raw';
  $('#chartPanel').hidden = mode === 'raw';
  $('#chartTitle').textContent = ranking ? '櫻坂ホストの順位推移' : '推移グラフ';
  $('#chartFoot').textContent = ranking
    ? '順位は1位が上です。掲載されなかった週は線をつながず、空白として表示します。'
    : '記録がない期間は線をつながず、空白として表示します。';
  $('#tableTitle').textContent = ranking ? '週間リーダーボード' : mode === 'raw' ? '詳細データ一覧' : '集計データ一覧';
  resetChartInfo();
}

function applyPreset(days) {
  const to = new Date();
  $('#to').value = to.toISOString().slice(0, 10);
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
  const threshold = mode === 'daily' ? 1.5 : mode === 'monthly' ? 45 : 10;
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
  const count = Math.min(5, dates.length);
  const indices = new Set();
  for (let i = 0; i < count; i++) {
    indices.add(Math.round((dates.length - 1) * i / Math.max(1, count - 1)));
  }
  const firstYear = String(dates[0] || '').slice(0, 4);
  const lastYear = String(dates.at(-1) || '').slice(0, 4);
  const showYear = firstYear !== lastYear;
  ctx.font = '11px system-ui';
  ctx.fillStyle = '#aaa3b5';
  ctx.textBaseline = 'top';
  for (const index of indices) {
    const text = shortDate(dates[index], showYear);
    const x = xPositions[index];
    const measured = ctx.measureText(text).width;
    const clampedX = Math.max(area.left, Math.min(width - area.right - measured, x - measured / 2));
    ctx.fillText(text, clampedX, height - area.bottom + 10);
  }
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

function draw(rows, key, selectionIndex = selectedChartIndex) {
  const { ctx, width, height } = prepareCanvas();
  const source = sampleRows(rows);
  const dates = source.map(rowDate);
  const area = { left: 54, right: 18, top: 24, bottom: 46 };
  area.width = Math.max(1, width - area.left - area.right);
  area.height = Math.max(1, height - area.top - area.bottom);
  const xPositions = makeXPositions(dates, area);
  const values = source.map((row) => {
    return finiteNumber(row[key]);
  });
  const finiteValues = values.filter((value) => value != null);

  setChartRange(dates);
  drawGrid(ctx, width, height, area);
  drawDateAxis(ctx, dates, xPositions, width, height, area);

  if (!finiteValues.length) {
    ctx.fillStyle = '#aaa3b5';
    ctx.font = '14px system-ui';
    ctx.fillText('表示できるデータがありません', area.left, area.top + 10);
    chartState = { type: 'summary', source, dates, xPositions, key, area };
    return;
  }

  let min = Math.min(...finiteValues);
  let max = Math.max(...finiteValues);
  const span = max - min || 1;
  const yFor = (value) => height - area.bottom - ((value - min) / span) * area.height;

  ctx.strokeStyle = '#f6c7d9';
  ctx.lineWidth = 2.5;
  let segmentOpen = false;
  ctx.beginPath();
  values.forEach((value, index) => {
    if (value == null || (index > 0 && isTemporalGap(dates[index - 1], dates[index], currentMode))) {
      segmentOpen = false;
      if (value == null) return;
    }
    const x = xPositions[index];
    const y = yFor(value);
    if (!segmentOpen) {
      ctx.moveTo(x, y);
      segmentOpen = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  values.forEach((value, index) => {
    if (value == null) return;
    ctx.beginPath();
    ctx.fillStyle = '#f6c7d9';
    ctx.arc(xPositions[index], yFor(value), 3, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = '#aaa3b5';
  ctx.font = '11px system-ui';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(fmt(max), 4, area.top + 4);
  ctx.fillText(fmt(min), 4, height - area.bottom);

  if (Number.isInteger(selectionIndex) && selectionIndex >= 0 && selectionIndex < source.length) {
    drawSelection(ctx, xPositions[selectionIndex], area);
    const value = values[selectionIndex];
    if (value != null) {
      ctx.beginPath();
      ctx.fillStyle = '#ffffff';
      ctx.arc(xPositions[selectionIndex], yFor(value), 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  chartState = { type: 'summary', source, dates, xPositions, key, values, area };
}

function drawRanking(rows, selectionIndex = selectedChartIndex) {
  const { ctx, width, height } = prepareCanvas();
  const groups = new Map();
  for (const row of rows) {
    const host = row.host_name;
    if (!host) continue;
    if (!groups.has(host)) groups.set(host, new Map());
    groups.get(host).set(row.ranking_date, row);
  }

  const hosts = [...groups.keys()].slice(0, 5);
  const dates = [...new Set(rows.map((row) => row.ranking_date).filter(Boolean))].sort();
  const area = { left: 54, right: 18, top: 30, bottom: 46 };
  area.width = Math.max(1, width - area.left - area.right);
  area.height = Math.max(1, height - area.top - area.bottom);
  const xPositions = makeXPositions(dates, area);
  const colors = ['#f6c7d9', '#9ec5ff', '#c7f6d4', '#ffd39e', '#d5b7ff'];
  const actualRanks = rows.map((row) => finiteNumber(row.rank)).filter((rank) => rank != null);

  setChartRange(dates);
  drawGrid(ctx, width, height, area);
  drawDateAxis(ctx, dates, xPositions, width, height, area);

  if (!hosts.length || !dates.length || !actualRanks.length) {
    ctx.fillStyle = '#aaa3b5';
    ctx.font = '14px system-ui';
    ctx.fillText('表示できる順位データがありません', area.left, area.top + 10);
    chartState = { type: 'ranking', rows, hosts, dates, groups, xPositions, area };
    return;
  }

  const minRank = Math.min(...actualRanks);
  const maxRank = Math.max(...actualRanks);
  const span = maxRank - minRank || 1;
  const yFor = (rank) => area.top + ((rank - minRank) / span) * area.height;

  hosts.forEach((host, hostIndex) => {
    const byDate = groups.get(host);
    ctx.strokeStyle = colors[hostIndex];
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    let segmentOpen = false;
    dates.forEach((date, index) => {
      const row = byDate.get(date);
      const rank = finiteNumber(row?.rank);
      if (rank == null || (index > 0 && isTemporalGap(dates[index - 1], date, 'ranking'))) {
        segmentOpen = false;
        if (rank == null) return;
      }
      const x = xPositions[index];
      const y = yFor(rank);
      if (!segmentOpen) {
        ctx.moveTo(x, y);
        segmentOpen = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    dates.forEach((date, index) => {
      const rank = finiteNumber(byDate.get(date)?.rank);
      if (rank == null) return;
      ctx.beginPath();
      ctx.fillStyle = colors[hostIndex];
      ctx.arc(xPositions[index], yFor(rank), 3, 0, Math.PI * 2);
      ctx.fill();
    });
  });

  ctx.fillStyle = '#aaa3b5';
  ctx.font = '11px system-ui';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${minRank}位`, 4, area.top + 4);
  ctx.fillText(`${maxRank}位`, 4, height - area.bottom);

  ctx.font = '12px system-ui';
  hosts.forEach((host, index) => {
    const x = Math.max(area.left, width - 190);
    const y = 18 + index * 18;
    ctx.fillStyle = colors[index];
    ctx.fillRect(x, y - 8, 10, 3);
    ctx.fillStyle = '#f7f4fb';
    ctx.fillText(host, x + 16, y - 3);
  });

  if (Number.isInteger(selectionIndex) && selectionIndex >= 0 && selectionIndex < dates.length) {
    drawSelection(ctx, xPositions[selectionIndex], area);
    hosts.forEach((host, hostIndex) => {
      const rank = finiteNumber(groups.get(host).get(dates[selectionIndex])?.rank);
      if (rank == null) return;
      ctx.beginPath();
      ctx.fillStyle = '#ffffff';
      ctx.arc(xPositions[selectionIndex], yFor(rank), 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = colors[hostIndex];
      ctx.arc(xPositions[selectionIndex], yFor(rank), 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  chartState = { type: 'ranking', rows, hosts, dates, groups, xPositions, area };
}

function showChartDetail(index) {
  if (!chartState || !Number.isInteger(index)) return;
  selectedChartIndex = index;

  if (chartState.type === 'ranking') {
    const date = chartState.dates[index];
    const items = chartState.hosts.map((host) => {
      const row = chartState.groups.get(host).get(date);
      const rank = finiteNumber(row?.rank);
      return `<div><strong>${escapeHtml(host)}</strong><span>${rank != null ? `${rank}位` : '圏外'}</span></div>`;
    }).join('');
    $('#chartDetail').innerHTML = `<time>${formatDate(date)}</time><div class="chart-detail-values">${items}</div>`;
    drawRanking(current, index);
    return;
  }

  const row = chartState.source[index];
  const value = chartState.values[index];
  const label = SUMMARY_LABELS[chartState.key] || chartState.key;
  $('#chartDetail').innerHTML = `<time>${formatDate(rowDate(row), true)}</time><div class="chart-detail-values"><div><strong>${escapeHtml(label)}</strong><span>${value != null ? fmt(value) : 'データなし'}</span></div></div>`;
  draw(current, chartState.key, index);
}

function selectChartFromPointer(event) {
  if (!chartState?.xPositions?.length) return;
  const rect = $('#chart').getBoundingClientRect();
  const x = event.clientX - rect.left;
  let nearest = 0;
  let distance = Infinity;
  chartState.xPositions.forEach((pointX, index) => {
    const nextDistance = Math.abs(pointX - x);
    if (nextDistance < distance) {
      distance = nextDistance;
      nearest = index;
    }
  });
  showChartDetail(nearest);
}

function columnsFor(mode) {
  if (mode === 'raw') return Object.keys(RAW_LABELS);
  if (mode === 'ranking') return Object.keys(RANKING_LABELS);
  return Object.keys(SUMMARY_LABELS);
}

function labelsFor(mode) {
  if (mode === 'raw') return RAW_LABELS;
  if (mode === 'ranking') return RANKING_LABELS;
  return SUMMARY_LABELS;
}

function rankDisplay(row, field) {
  const value = finiteNumber(row[field]);
  if (value != null) return `${value}位`;
  if (field === 'rank' && row.is_out_of_rank) return '<span class="rank-out">圏外</span>';
  if (field === 'previous_rank' && row.previous_out_of_rank) return '<span class="rank-out">圏外</span>';
  return '—';
}

function rankChangeDisplay(row) {
  const currentRank = finiteNumber(row.rank);
  const previousRank = finiteNumber(row.previous_rank);
  if (currentRank == null && previousRank != null) {
    return { text: '圏外', className: 'rank-down' };
  }
  if (currentRank != null && row.previous_out_of_rank) {
    return { text: '再登場', className: 'rank-up' };
  }
  if (currentRank == null && row.previous_out_of_rank) {
    return { text: '圏外', className: 'rank-same' };
  }
  const change = finiteNumber(row.rank_change);
  if (change == null) return { text: '—', className: '' };
  if (change > 0) return { text: `↑${change}`, className: 'rank-up' };
  if (change < 0) return { text: `↓${Math.abs(change)}`, className: 'rank-down' };
  return { text: '→0', className: 'rank-same' };
}

function displayCell(row, column, mode) {
  if (mode === 'ranking') {
    if (column === 'ranking_date') return escapeHtml(formatDate(row[column]));
    if (column === 'rank' || column === 'previous_rank') return rankDisplay(row, column);
    if (column === 'rank_change') {
      const change = rankChangeDisplay(row);
      return `<span class="${change.className}">${change.text}</span>`;
    }
  }
  if (column === 'period_key' || column === 'observed_jst') return escapeHtml(formatDate(row[column], column === 'observed_jst'));
  const value = row[column];
  return typeof value === 'number' ? fmt(value) : escapeHtml(value);
}

function renderTable(rows, mode, append = false) {
  const columns = columnsFor(mode);
  const labels = labelsFor(mode);
  if (!append) {
    $('#thead').innerHTML = `<tr>${columns.map((column) => `<th>${labels[column]}</th>`).join('')}</tr>`;
    $('#tbody').innerHTML = '';
  }

  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    if (mode === 'ranking' && row.is_out_of_rank) tr.classList.add('out-of-rank-row');
    tr.innerHTML = columns.map((column) => {
      const rankClass = mode === 'ranking' && column === 'rank' ? ' class="rank-cell"' : '';
      return `<td${rankClass}>${displayCell(row, column, mode)}</td>`;
    }).join('');
    fragment.appendChild(tr);
  }
  $('#tbody').appendChild(fragment);
}

function renderWeeklyMetrics(rows = []) {
  const columns = Object.keys(WEEKLY_METRIC_LABELS);
  $('#weeklyThead').innerHTML = `<tr>${columns.map((column) => `<th>${WEEKLY_METRIC_LABELS[column]}</th>`).join('')}</tr>`;
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = columns.map((column) => `<td>${column === 'ranking_date' ? escapeHtml(formatDate(row[column])) : fmt(row[column])}</td>`).join('');
    fragment.appendChild(tr);
  }
  $('#weeklyTbody').replaceChildren(fragment);
}

function updateSummary(rows, mode) {
  if (mode === 'ranking') {
    const rankedRows = rows.filter((row) => finiteNumber(row.rank) != null);
    const ranks = rankedRows.map((row) => finiteNumber(row.rank));
    const hosts = new Set(rows.map((row) => row.host_name).filter(Boolean));
    const dates = new Set(rows.map((row) => row.ranking_date).filter(Boolean));
    $('#periodLabel').textContent = '順位記録';
    $('#maxLabel').textContent = '最高順位';
    $('#streamLabel').textContent = '表示ホスト';
    $('#memberLabel').textContent = '対象週';
    $('#periods').textContent = fmt(rankedRows.length);
    if (ranks.length) {
      const bestRank = Math.min(...ranks);
      const bestRows = rankedRows
        .filter((row) => finiteNumber(row.rank) === bestRank)
        .sort((a, b) => String(b.ranking_date).localeCompare(String(a.ranking_date)));
      const latestBest = bestRows[0];
      const more = bestRows.length > 1 ? `ほか${bestRows.length - 1}回` : '';
      $('#maxListener').innerHTML = `${bestRank}位<small>${escapeHtml(latestBest.host_name)}・${formatDate(latestBest.ranking_date)}${more ? `・${more}` : ''}</small>`;
    } else {
      $('#maxListener').textContent = '—';
    }
    $('#streamGrowth').textContent = fmt(hosts.size);
    $('#memberGrowth').textContent = fmt(dates.size);
    return;
  }

  $('#periodLabel').textContent = mode === 'raw' ? '表示件数' : '期間数';
  $('#maxLabel').textContent = '最大同接';
  $('#streamLabel').textContent = '再生数増加';
  $('#memberLabel').textContent = 'メンバー増加';
  $('#periods').textContent = fmt(rows.length);
  let maxListener = null;
  let streamGrowth = 0;
  let memberGrowth = 0;
  for (const row of rows) {
    const listener = finiteNumber(row.listener_max ?? row.listener_count);
    if (listener != null && (maxListener == null || listener > maxListener)) maxListener = listener;
    streamGrowth += Number(row.stream_growth) || 0;
    memberGrowth += Number(row.member_growth) || 0;
  }
  $('#maxListener').textContent = fmt(maxListener);
  $('#streamGrowth').textContent = mode === 'raw' ? '—' : fmt(streamGrowth);
  $('#memberGrowth').textContent = mode === 'raw' ? '—' : fmt(memberGrowth);
}

function cacheKey(mode, from, to, extra = '') { return `history:v7:${mode}:${from}:${to}:${extra}`; }
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

function shouldShowRankingChart(rows) {
  const scope = $('#rankingScope').value;
  const search = $('#host').value.trim();
  const hostCount = new Set(rows.map((row) => row.host_name).filter(Boolean)).size;
  return scope === 'featured' || Boolean(search) || hostCount <= 5;
}

async function load({ append = false } = {}) {
  if (loading) return;
  loading = true;
  selectedChartIndex = null;
  const mode = currentMode;
  const from = $('#from').value;
  const to = $('#to').value;
  const scope = mode === 'ranking' ? $('#rankingScope').value : '';
  const host = mode === 'ranking' ? $('#host').value.trim() : '';
  const extra = `${scope}:${host}`;
  const key = cacheKey(mode, from, to, extra);
  $('#notice').textContent = append ? '続きを読み込み中…' : '読み込み中…';

  try {
    let data = !append && mode !== 'raw' ? readCache(key) : null;
    if (!data) {
      const params = new URLSearchParams({ mode, from, to, v: '7' });
      if (mode === 'raw') {
        params.set('limit', '200');
        if (append && nextCursor) params.set('cursor', nextCursor);
      }
      if (mode === 'ranking') {
        params.set('limit', '5000');
        params.set('scope', scope);
        if (host) params.set('host', host);
      }
      const response = await fetch(`/api/history?${params}`, { cache: mode === 'raw' ? 'no-store' : 'default' });
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

    if (mode === 'ranking') {
      renderWeeklyMetrics(data.weekly_metrics || []);
      $('#rankingWeeklyPanel').hidden = false;
      const showChart = shouldShowRankingChart(current);
      $('#chartPanel').hidden = !showChart;
      if (showChart) drawRanking(current);
    } else {
      $('#rankingWeeklyPanel').hidden = true;
      $('#chartPanel').hidden = mode === 'raw';
      if (mode !== 'raw') draw(current, $('#metric').value);
    }

    $('#chartDetail').innerHTML = '<span>グラフをタッチまたはクリックすると、その時点の詳細を表示します。</span>';

    if (mode === 'ranking' && data.setup_required) {
      $('#notice').textContent = '週間リーダーボードのデータがまだありません。ランキングSQLを投入してください。';
    } else if (mode === 'ranking') {
      const selected = host
        ? `「${host}」を検索`
        : scope === 'featured'
          ? '櫻坂を表示'
          : '全ホストを表示';
      const suffix = data.truncated ? '（最大5000件）' : '';
      $('#notice').textContent = `${selected}：${fmt(current.length)}行（圏外週を含む）${suffix}`;
    } else if (mode === 'raw') {
      $('#notice').textContent = `${fmt(current.length)}件を表示中（200件ずつ取得）`;
    } else {
      $('#notice').textContent = `${fmt(current.length)}期間を集計済みデータから表示`;
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
  if (currentMode !== 'ranking') {
    selectedChartIndex = null;
    draw(current, $('#metric').value);
    $('#chartDetail').innerHTML = '<span>グラフをタッチまたはクリックすると、その時点の詳細を表示します。</span>';
  }
};
$('#rankingScope').onchange = () => {
  $('#host').value = '';
  load();
};
$('#host').addEventListener('keydown', (event) => { if (event.key === 'Enter') load(); });
$('#chart').addEventListener('pointerup', selectChartFromPointer);
$('#csv').onclick = () => {
  if (!current.length) return;
  const columns = columnsFor(currentMode);
  const labels = labelsFor(currentMode);
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const rowValue = (row, column) => {
    if (currentMode === 'ranking' && column === 'rank' && row.is_out_of_rank) return '圏外';
    if (currentMode === 'ranking' && column === 'previous_rank' && row.previous_out_of_rank) return '圏外';
    return row[column];
  };
  const csv = [columns.map((column) => escape(labels[column])).join(','),
    ...current.map((row) => columns.map((column) => escape(rowValue(row, column))).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `buddies-${currentMode}-${$('#from').value}-${$('#to').value}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (currentMode === 'ranking' && !$('#chartPanel').hidden) drawRanking(current, selectedChartIndex);
    else if (currentMode !== 'raw') draw(current, $('#metric').value, selectedChartIndex);
  }, 180);
});

setMode('weekly');
applyPreset('all');
load();
