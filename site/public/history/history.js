const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const CACHE_MS = 10 * 60 * 1000;
const MAX_CHART_POINTS = 240;

let current = [];
let currentMode = 'weekly';
let nextCursor = null;
let loading = false;
let resizeTimer = null;

const MODE_HELP = {
  daily: ['日次集計', '1日ごとの最大同接、再生数増加、メンバー増加を表示します。'],
  weekly: ['週次集計', '週ごとの最大同接、再生数増加、メンバー増加を軽量に表示します。'],
  monthly: ['月次集計', '月ごとの長期推移を少ない読み取り量で表示します。'],
  raw: ['詳細データ', '元の記録を200件ずつ表示します。検索範囲は最大31日です。'],
  ranking: ['チャンネルランキング', '日付別の順位とチャンネルごとの順位推移を表示します。'],
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
  ranking_date: '日付', ranking_type: 'ランキング種別', rank: '順位',
  channel_name: 'チャンネル', channel_alias: '別名', listener_count: 'リスナー',
  member_count: 'メンバー', total_listens: '累計聴取回数', source_sheet: '出典', quality_score: '品質',
};

const fmt = (value) => value == null || value === ''
  ? '—'
  : Number(value).toLocaleString('ja-JP', { maximumFractionDigits: 1 });

const escapeHtml = (value) => String(value ?? '—')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

$('#to').value = new Date().toISOString().slice(0, 10);

function setMode(mode) {
  currentMode = mode;
  $$('.mode-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
  const [title, description] = MODE_HELP[mode];
  $('#guide').innerHTML = `<strong>${title}</strong><span>${description}</span>`;
  const ranking = mode === 'ranking';
  $('#rankingTypeWrap').hidden = !ranking;
  $('#channelWrap').hidden = !ranking;
  $('#metric').disabled = mode === 'raw';
  $('#chartPanel').hidden = mode === 'raw';
  $('#chartTitle').textContent = ranking ? '順位推移' : '推移グラフ';
  $('#chartFoot').textContent = ranking
    ? 'ランキングは1位が上になるように表示します。'
    : '値が大きいほどグラフの上に表示されます。';
  $('#tableTitle').textContent = ranking ? 'ランキング一覧' : mode === 'raw' ? '詳細データ一覧' : '集計データ一覧';
  if (ranking) $('#metric').value = 'rank';
  else if ($('#metric').value === 'rank') $('#metric').value = 'listener_max';
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

  const ranking = currentMode === 'ranking';
  const points = source.map((row, index) => ({ x: index, y: Number(row[key]), row }))
    .filter((point) => Number.isFinite(point.y));
  if (points.length < 2) {
    ctx.fillStyle = '#aaa3b5';
    ctx.font = '14px system-ui';
    ctx.fillText('表示できるデータが不足しています', 20, 34);
    return;
  }

  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    if (point.y < min) min = point.y;
    if (point.y > max) max = point.y;
  }

  const padding = 34;
  const span = max - min || 1;
  ctx.strokeStyle = '#ffffff18';
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const y = padding + (height - padding * 2) * i / 4;
    ctx.beginPath(); ctx.moveTo(padding, y); ctx.lineTo(width - padding, y); ctx.stroke();
  }

  ctx.strokeStyle = '#f6c7d9';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = padding + (width - padding * 2) * (point.x / (source.length - 1 || 1));
    const ratio = (point.y - min) / span;
    const y = ranking
      ? padding + ratio * (height - padding * 2)
      : height - padding - ratio * (height - padding * 2);
    index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = '#aaa3b5';
  ctx.font = '11px system-ui';
  const top = ranking ? min : max;
  const bottom = ranking ? max : min;
  ctx.fillText(fmt(top), 4, 16);
  ctx.fillText(fmt(bottom), 4, height - 8);
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
    tr.innerHTML = columns.map((column) => {
      const value = row[column];
      const display = typeof value === 'number' ? fmt(value) : escapeHtml(value);
      const rankClass = mode === 'ranking' && column === 'rank' ? ' class="rank-cell"' : '';
      return `<td${rankClass}>${display}</td>`;
    }).join('');
    fragment.appendChild(tr);
  }
  $('#tbody').appendChild(fragment);
}

function updateSummary(rows, mode) {
  if (mode === 'ranking') {
    const ranks = rows.map((row) => Number(row.rank)).filter(Number.isFinite);
    const channels = new Set(rows.map((row) => row.channel_name).filter(Boolean));
    const dates = new Set(rows.map((row) => row.ranking_date).filter(Boolean));
    $('#periodLabel').textContent = 'ランキング記録';
    $('#maxLabel').textContent = '最高順位';
    $('#streamLabel').textContent = 'チャンネル数';
    $('#memberLabel').textContent = '対象日数';
    $('#periods').textContent = fmt(rows.length);
    $('#maxListener').textContent = ranks.length ? `${Math.min(...ranks)}位` : '—';
    $('#streamGrowth').textContent = fmt(channels.size);
    $('#memberGrowth').textContent = fmt(dates.size);
    return;
  }

  $('#periodLabel').textContent = mode === 'raw' ? '表示件数' : '期間数';
  $('#maxLabel').textContent = '最大同接';
  $('#streamLabel').textContent = '再生数増加';
  $('#memberLabel').textContent = 'メンバー増加';
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

function cacheKey(mode, from, to, extra = '') { return `history:v3:${mode}:${from}:${to}:${extra}`; }
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

function populateRankingTypes(types = []) {
  const select = $('#rankingType');
  const selected = select.value;
  select.innerHTML = '<option value="">すべて</option>' + types
    .map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}

async function load({ append = false } = {}) {
  if (loading) return;
  loading = true;
  const mode = currentMode;
  const from = $('#from').value;
  const to = $('#to').value;
  const rankingType = mode === 'ranking' ? $('#rankingType').value : '';
  const channel = mode === 'ranking' ? $('#channel').value.trim() : '';
  const extra = `${rankingType}:${channel}`;
  const key = cacheKey(mode, from, to, extra);
  $('#notice').textContent = append ? '続きを読み込み中…' : '読み込み中…';

  try {
    let data = !append && mode !== 'raw' ? readCache(key) : null;
    if (!data) {
      const params = new URLSearchParams({ mode, from, to });
      if (mode === 'raw') {
        params.set('limit', '200');
        if (append && nextCursor) params.set('cursor', nextCursor);
      }
      if (mode === 'ranking') {
        params.set('limit', '1000');
        if (rankingType) params.set('ranking_type', rankingType);
        if (channel) params.set('channel', channel);
      }
      const response = await fetch(`/api/history?${params}`, { cache: mode === 'raw' ? 'no-store' : 'default' });
      data = await response.json();
      if (!data.ok) throw new Error(data.error);
      if (!append && mode !== 'raw') writeCache(key, data);
    }

    if (mode === 'ranking') populateRankingTypes(data.ranking_types || []);
    if (append) current.push(...(data.rows || []));
    else current = data.rows || [];
    nextCursor = data.next_cursor || null;

    updateSummary(current, mode);
    renderTable(data.rows || [], mode, append);
    $('#chartPanel').hidden = mode === 'raw';
    if (mode === 'ranking') draw(current, 'rank');
    else if (mode !== 'raw') draw(current, $('#metric').value);
    $('#more').hidden = mode !== 'raw' || !data.has_more;

    if (mode === 'ranking' && data.setup_required) {
      $('#notice').textContent = 'ランキングテーブルは作成済みですが、まだランキングデータがありません。別SQLを投入するとここに表示されます。';
    } else if (mode === 'ranking') {
      const suffix = data.truncated ? '（最大1000件まで表示）' : '';
      $('#notice').textContent = `${fmt(current.length)}件のランキング記録を表示 ${suffix}`;
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
$('#metric').onchange = () => { if (currentMode !== 'ranking') draw(current, $('#metric').value); };
$('#rankingType').onchange = () => load();
$('#channel').addEventListener('keydown', (event) => { if (event.key === 'Enter') load(); });
$('#csv').onclick = () => {
  if (!current.length) return;
  const columns = columnsFor(currentMode);
  const labels = labelsFor(currentMode);
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const csv = [columns.map((column) => escape(labels[column])).join(','),
    ...current.map((row) => columns.map((column) => escape(row[column])).join(','))].join('\n');
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
    if (currentMode === 'ranking') draw(current, 'rank');
    else if (currentMode !== 'raw') draw(current, $('#metric').value);
  }, 180);
});

setMode('weekly');
applyPreset('all');
load();
