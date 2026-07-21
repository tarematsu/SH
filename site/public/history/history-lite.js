(() => {
  'use strict';

  const PAGE_SIZE = 200;
  const CACHE_PREFIX = 'sh.history.v3:';
  const MAX_CACHE_CHARS = 1_500_000;
  const DAY_MS = 86_400_000;
  const integer = new Intl.NumberFormat('ja-JP');
  const decimal = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
  const dateOnly = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateTime = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  const MODES = Object.freeze({
    daily: { title: '日次集計', table: '日次集計一覧', chart: '主要指標の推移' },
    weekly: { title: '週次集計', table: '週次集計一覧', chart: '主要指標の推移' },
    monthly: { title: '月次集計', table: '月次集計一覧', chart: '主要指標の推移' },
    ranking: { title: '週間リーダーボード', table: '週間リーダーボード', chart: '' },
    tracks: { title: '再生曲', table: '再生曲一覧', chart: '' },
    broadcasts: { title: '公式ストリーム比較', table: '公式ストリーム一覧', chart: '公式ステヘ 同接推移（開始0分比較）' },
  });

  const SUMMARY_COLUMNS = [
    ['period_key', '期間'], ['sample_count', '記録数'], ['reliable_sample_count', '有効記録数'],
    ['listener_avg', '平均同接'], ['listener_min', '最小同接'], ['listener_max', '最大同接'],
    ['stream_start', '再生数（開始）'], ['stream_end', '再生数（終了）'], ['stream_growth', '再生数増加'],
    ['member_start', 'メンバー（開始）'], ['member_end', 'メンバー（終了）'], ['member_growth', 'メンバー増加'],
    ['likes_max', '最大いいね'], ['distinct_tracks', '曲数'], ['primary_host', '主なホスト'], ['quality_score', '品質'],
  ];
  const TRACK_COLUMNS = [
    ['play_date', '日付'], ['title', '曲名'], ['artist', 'アーティスト'], ['play_count', '再生回数'],
    ['daily_share', 'その日の割合'], ['like_count', 'いいね数'],
    ['first_played_at', '最初の再生'], ['last_played_at', '最後の再生'],
  ];
  const BROADCAST_COLUMNS = [
    ['event_name', '放送名'], ['started_jst', '開始日時'], ['ended_jst', '終了日時'],
    ['sample_count', '記録数'], ['listener_avg', '平均同接'], ['listener_min', '最小同接'],
    ['listener_max', '最大同接'], ['likes_max', '最大いいね'], ['distinct_tracks', '曲数'], ['host_handle', 'ホスト'],
  ];
  const RANKING_COLUMNS = [
    ['ranking_date', '週'], ['host_name', 'ホスト'], ['rank', '順位'], ['previous_rank', '前週順位'],
    ['rank_change', '前週比'], ['ranking_type', 'ランキング種別'], ['source_sheet', '順位データ出典'], ['quality_score', '品質'],
  ];

  const state = {
    mode: 'weekly',
    rows: [],
    tableRows: [],
    visibleRows: PAGE_SIZE,
    data: null,
    controller: null,
    requestToken: 0,
    chartModel: null,
    selectedChartIndex: null,
    resizeTimer: 0,
  };

  const el = (id) => document.getElementById(id);
  const finite = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const numberText = (value) => finite(value) == null ? '—' : decimal.format(Number(value));
  const todayJst = () => new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const todayUtc = () => new Date().toISOString().slice(0, 10);

  function parseDate(value) {
    if (value === null || value === undefined || value === '') return null;
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date(`${text}T00:00:00Z`);
    const number = Number(value);
    return Number.isFinite(number) && number > 100_000_000_000 ? new Date(number) : new Date(text);
  }

  function formatDate(value, includeTime = false) {
    const date = parseDate(value);
    if (!date || Number.isNaN(date.getTime())) return '—';
    return (includeTime ? dateTime : dateOnly).format(date);
  }

  function setText(id, value) {
    const node = el(id);
    if (node) node.textContent = String(value);
  }

  function setNotice(text, error = false) {
    setText('notice', text);
    el('notice')?.classList.toggle('error', error);
  }

  function cacheKey(url) {
    return `${CACHE_PREFIX}${url}`;
  }

  function readCache(url, ttl) {
    try {
      const cached = JSON.parse(sessionStorage.getItem(cacheKey(url)) || 'null');
      return cached && Date.now() - Number(cached.at || 0) < ttl ? cached.data : null;
    } catch {
      return null;
    }
  }

  function writeCache(url, data) {
    try {
      const encoded = JSON.stringify({ at: Date.now(), data });
      if (encoded.length <= MAX_CACHE_CHARS) sessionStorage.setItem(cacheKey(url), encoded);
    } catch {}
  }

  async function fetchJson(url, { ttl = 5 * 60_000, signal, force = false } = {}) {
    if (force) sessionStorage.removeItem(cacheKey(url));
    const cached = force ? null : readCache(url, ttl);
    if (cached) return { data: cached, cached: true };
    const response = await fetch(url, { signal, headers: { accept: 'application/json' } });
    const data = await response.json();
    if (!response.ok || !data?.ok) throw new Error(data?.error || `API ${response.status}`);
    writeCache(url, data);
    return { data, cached: false };
  }

  function mondayOf(value) {
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString().slice(0, 10);
  }

  function sundayOf(value) {
    const date = new Date(`${mondayOf(value)}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 6);
    return date.toISOString().slice(0, 10);
  }

  function applyPreset(days) {
    const to = new Date();
    const from = new Date(to);
    if (days === 'all') from.setTime(Date.UTC(2024, 4, 1));
    else from.setUTCDate(from.getUTCDate() - Math.max(1, Number(days) || 30));
    el('from').value = from.toISOString().slice(0, 10);
    el('to').value = to.toISOString().slice(0, 10);
    document.querySelectorAll('#rangePresets button').forEach((button) =>
      button.classList.toggle('active', button.dataset.days === String(days)));
  }

  function columnsFor(mode) {
    if (mode === 'tracks') return TRACK_COLUMNS;
    if (mode === 'ranking') return RANKING_COLUMNS;
    if (mode === 'broadcasts') return BROADCAST_COLUMNS;
    return SUMMARY_COLUMNS;
  }

  function displayCell(key, row, mode = state.mode) {
    const value = row?.[key];
    if (value == null || value === '') return '—';
    if (key.endsWith('_at') || key.endsWith('_jst')) return formatDate(value, true);
    if (key === 'daily_share') return `${numberText(Number(value) * 100)}%`;
    if (key === 'quality_score') return numberText(value);
    if (['rank_change', 'stream_growth', 'member_growth'].includes(key)) {
      const number = finite(value);
      return number == null ? '—' : `${number > 0 ? '+' : ''}${integer.format(number)}`;
    }
    if (typeof value === 'number') return numberText(value);
    if (mode === 'tracks' && key === 'title') return value || row?.display_title || row?.spotify_id || '曲名不明';
    return String(value);
  }

  function tableOrder(rows, mode) {
    if (mode === 'tracks') return [...rows].sort((a, b) => (b.first_played_at || 0) - (a.first_played_at || 0));
    if (mode === 'ranking') return [...rows].sort((a, b) => String(b.ranking_date || '').localeCompare(String(a.ranking_date || '')) || Number(a.rank || 9999) - Number(b.rank || 9999));
    return [...rows].reverse();
  }

  function renderTable(reset = false) {
    if (reset) state.visibleRows = PAGE_SIZE;
    const columns = columnsFor(state.mode);
    const head = document.createElement('tr');
    for (const [, label] of columns) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      head.appendChild(cell);
    }
    el('thead').replaceChildren(head);
    const rows = state.tableRows.slice(0, state.visibleRows);
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const [key] of columns) {
        const td = document.createElement('td');
        td.textContent = displayCell(key, row);
        tr.appendChild(td);
      }
      fragment.appendChild(tr);
    }
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = columns.length;
      td.textContent = 'データがありません。';
      tr.appendChild(td);
      fragment.appendChild(tr);
    }
    el('tbody').replaceChildren(fragment);
    el('more').hidden = state.tableRows.length <= state.visibleRows;
  }

  function renderRankingWeekly(rows) {
    const head = document.createElement('tr');
    for (const label of ['週', '平均同接', '再生数増加', 'メンバー増加']) {
      const th = document.createElement('th');
      th.textContent = label;
      head.appendChild(th);
    }
    const body = document.createDocumentFragment();
    for (const row of Array.isArray(rows) ? rows : []) {
      const tr = document.createElement('tr');
      for (const value of [row.period_key, numberText(row.listener_avg), numberText(row.stream_growth), numberText(row.member_growth)]) {
        const td = document.createElement('td');
        td.textContent = value ?? '—';
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    el('rankingWeeklyThead').replaceChildren(head);
    el('rankingWeeklyTbody').replaceChildren(body);
  }

  function average(rows, key) {
    const values = rows.map((row) => finite(row?.[key])).filter((value) => value != null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }

  function sum(rows, key) {
    return rows.reduce((total, row) => total + (finite(row?.[key]) || 0), 0);
  }

  function updateSummary() {
    const rows = state.rows;
    setText('periodLabel', state.mode === 'tracks' ? '曲数' : state.mode === 'ranking' ? '順位行' : '期間数');
    setText('maxLabel', state.mode === 'tracks' ? '再生回数' : '平均同接');
    setText('streamLabel', state.mode === 'tracks' ? '最大いいね' : '再生数増加');
    setText('memberLabel', state.mode === 'tracks' ? '対象日数' : 'メンバー増加');
    setText('periods', numberText(rows.length));
    if (state.mode === 'tracks') {
      setText('maxListener', numberText(sum(rows, 'play_count')));
      setText('streamGrowth', numberText(Math.max(0, ...rows.map((row) => finite(row.like_count) || 0))));
      setText('memberGrowth', numberText(new Set(rows.map((row) => row.play_date).filter(Boolean)).size));
    } else if (state.mode === 'ranking') {
      setText('maxListener', '—');
      setText('streamGrowth', '—');
      setText('memberGrowth', '—');
    } else {
      setText('maxListener', numberText(average(rows, 'listener_avg')));
      setText('streamGrowth', numberText(average(rows, 'stream_growth')));
      setText('memberGrowth', numberText(average(rows, 'member_growth')));
    }
  }

  function cssColor(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  function prepareCanvas() {
    const canvas = el('chart');
    const context = canvas.getContext('2d');
    const width = Math.max(320, Math.round(canvas.clientWidth || 960));
    const height = Math.max(260, Math.round(canvas.clientHeight || 360));
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    return { canvas, context, width, height };
  }

  function drawEmpty(message) {
    const { context, width, height } = prepareCanvas();
    context.fillStyle = cssColor('--muted', '#667287');
    context.font = '14px system-ui';
    context.textAlign = 'center';
    context.fillText(message, width / 2, height / 2);
    el('chartLegend').replaceChildren();
    setText('chartStartDate', '—');
    setText('chartEndDate', '—');
    setText('chartDetail', 'グラフを表示できるデータがありません。');
    state.chartModel = null;
  }

  function drawSummaryChart() {
    const rows = state.rows.filter((row) => finite(row.listener_avg) != null);
    if (!rows.length) return drawEmpty('表示できる集計データがありません。');
    const { canvas, context, width, height } = prepareCanvas();
    const area = { left: 50, right: 20, top: 18, bottom: 42 };
    area.width = width - area.left - area.right;
    area.height = height - area.top - area.bottom;
    const values = rows.map((row) => finite(row.listener_avg) || 0);
    const maximum = Math.max(1, ...values);
    const minimum = Math.min(...values);
    const range = Math.max(1, maximum - minimum);
    const positions = rows.map((_, index) => area.left + area.width * index / Math.max(1, rows.length - 1));
    context.strokeStyle = 'rgba(31,45,68,.12)';
    context.lineWidth = 1;
    for (let index = 0; index <= 4; index += 1) {
      const y = area.top + area.height * index / 4;
      context.beginPath();
      context.moveTo(area.left, y);
      context.lineTo(width - area.right, y);
      context.stroke();
    }
    const color = cssColor('--accent', '#d93f79');
    context.strokeStyle = color;
    context.lineWidth = 2.5;
    context.beginPath();
    values.forEach((value, index) => {
      const y = area.top + area.height - (value - minimum) / range * area.height;
      if (index === 0) context.moveTo(positions[index], y);
      else context.lineTo(positions[index], y);
    });
    context.stroke();
    if (Number.isInteger(state.selectedChartIndex) && rows[state.selectedChartIndex]) {
      const row = rows[state.selectedChartIndex];
      setText('chartDetail', `${row.period_key || ''}　平均同接 ${numberText(row.listener_avg)}　再生増加 ${numberText(row.stream_growth)}　メンバー増加 ${numberText(row.member_growth)}`);
    } else {
      setText('chartDetail', 'グラフをタッチすると、その期間の詳細を表示します。');
    }
    const legend = document.createElement('span');
    legend.innerHTML = `<i style="background:${color}"></i>平均同接`;
    el('chartLegend').replaceChildren(legend);
    setText('chartStartDate', rows[0].period_key || '—');
    setText('chartEndDate', rows.at(-1).period_key || '—');
    state.chartModel = { positions, rows };
    canvas.dataset.left = String(area.left);
    canvas.dataset.chartWidth = String(area.width);
  }

  function drawChart() {
    if (['tracks', 'ranking', 'broadcasts'].includes(state.mode)) return;
    drawSummaryChart();
  }

  function handleChartPointer(event) {
    if (!state.chartModel || state.mode === 'broadcasts') return;
    const bounds = el('chart').getBoundingClientRect();
    const pointer = event.clientX - bounds.left;
    let nearest = 0;
    let distance = Infinity;
    state.chartModel.positions.forEach((position, index) => {
      const next = Math.abs(position - pointer);
      if (next < distance) { distance = next; nearest = index; }
    });
    state.selectedChartIndex = nearest;
    drawSummaryChart();
  }

  function updateModeUi() {
    const config = MODES[state.mode];
    document.querySelectorAll('#modeTabs button').forEach((button) => {
      const selected = button.dataset.mode === state.mode;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    setText('guideTitle', config.title);
    setText('tableTitle', config.table);
    setText('chartTitle', config.chart);
    el('controls').hidden = state.mode === 'broadcasts';
    el('standardControls').hidden = state.mode === 'tracks';
    el('trackControls').hidden = state.mode !== 'tracks';
    el('rankingControls').hidden = state.mode !== 'ranking';
    el('chartPanel').hidden = ['tracks', 'ranking'].includes(state.mode);
    el('rankingWeeklyPanel').hidden = state.mode !== 'ranking';
    setText('chartFoot', state.mode === 'broadcasts'
      ? '横軸は各放送の開始からの経過時間です。'
      : '平均同接の推移を表示します。');
    state.selectedChartIndex = null;
    state.chartModel = null;
  }

  function resetData() {
    state.rows = [];
    state.tableRows = [];
    state.data = null;
    state.visibleRows = PAGE_SIZE;
    el('tbody').replaceChildren();
    el('chartLegend').replaceChildren();
  }

  function renderLoadedData() {
    updateSummary();
    state.tableRows = tableOrder(state.rows, state.mode);
    renderTable(true);
    renderRankingWeekly(state.data?.weekly_metrics || []);
    if (!['tracks', 'ranking', 'broadcasts'].includes(state.mode)) requestAnimationFrame(drawChart);
  }

  async function resolveTrackRange(signal, force) {
    if (!el('trackDate').value) {
      const { data } = await fetchJson('/api/track-history?latest=1', { ttl: 5 * 60_000, signal, force });
      el('trackDate').value = data.latest_date || todayUtc();
    }
    if (el('trackWeekMode').checked) {
      el('from').value = mondayOf(el('trackDate').value);
      el('to').value = sundayOf(el('trackDate').value);
    } else {
      el('from').value = el('trackDate').value;
      el('to').value = el('trackDate').value;
    }
  }

  async function loadMode({ force = false } = {}) {
    const token = ++state.requestToken;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const mode = state.mode;
    el('load').disabled = true;
    setNotice('読み込み中…');

    try {
      if (mode === 'tracks') await resolveTrackRange(controller.signal, force);
      if (mode === 'broadcasts') {
        el('from').value = '2024-05-01';
        el('to').value = todayJst();
      }
      const from = el('from').value;
      const to = el('to').value;
      let data;
      let cached = false;

      if (mode === 'tracks') {
        const url = `/api/track-history?${new URLSearchParams({ from, to, limit: '2000' })}`;
        ({ data, cached } = await fetchJson(url, { ttl: 10 * 60_000, signal: controller.signal, force }));
        if (token !== state.requestToken || state.mode !== mode) return;
        state.data = data;
        state.rows = Array.isArray(data.rows) ? data.rows : [];
        setNotice(`${formatDate(from)}〜${formatDate(to)} · ${numberText(state.rows.length)}件 · ${data.timezone || 'UTC'}${data.truncated ? ' · 表示上限' : ''}${cached ? ' · キャッシュ' : ''}`);
      } else if (mode === 'ranking') {
        const params = new URLSearchParams({ mode, from, to, scope: el('rankingScope').value, limit: '5000' });
        const host = el('rankingHost').value.trim();
        if (host) params.set('host', host);
        const url = `/api/history?${params}`;
        ({ data, cached } = await fetchJson(url, { ttl: 5 * 60_000, signal: controller.signal, force }));
        if (token !== state.requestToken || state.mode !== mode) return;
        state.data = data;
        state.rows = Array.isArray(data.rows) ? data.rows : [];
        setNotice(`${numberText(state.rows.length)}行${data.truncated ? ' · 最大5000件' : ''}${cached ? ' · キャッシュ' : ''}`);
      } else {
        const url = `/api/history?${new URLSearchParams({ mode, from, to })}`;
        ({ data, cached } = await fetchJson(url, { ttl: mode === 'broadcasts' ? 15 * 60_000 : 5 * 60_000, signal: controller.signal, force }));
        if (token !== state.requestToken || state.mode !== mode) return;
        state.data = data;
        state.rows = Array.isArray(data.rows) ? data.rows : [];
        setNotice(`${numberText(state.rows.length)}件を表示${cached ? ' · キャッシュ' : ''}`);
      }

      renderLoadedData();
    } catch (error) {
      if (error?.name !== 'AbortError' && token === state.requestToken) {
        console.error(error);
        resetData();
        renderLoadedData();
        setNotice(`データを取得できませんでした: ${error.message}`, true);
      }
    } finally {
      if (token === state.requestToken) {
        state.controller = null;
        el('load').disabled = false;
      }
    }
  }

  function setMode(mode) {
    if (!MODES[mode]) return;
    state.controller?.abort();
    state.requestToken += 1;
    state.mode = mode;
    resetData();
    updateModeUi();
    history.replaceState(null, '', `#${mode}`);
    loadMode();
  }

  function exportCsv() {
    const columns = columnsFor(state.mode);
    const lines = [
      columns.map(([, label]) => label),
      ...state.rows.map((row) => columns.map(([key]) => displayCell(key, row))),
    ].map((line) => line.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(','));
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `sh-${state.mode}-${todayJst()}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function start() {
    el('to').value = todayJst();
    applyPreset('all');
    document.querySelectorAll('#modeTabs button').forEach((button) =>
      button.addEventListener('click', () => setMode(button.dataset.mode)));
    document.querySelectorAll('#rangePresets button').forEach((button) =>
      button.addEventListener('click', () => {
        applyPreset(button.dataset.days);
        loadMode();
      }));
    el('load').addEventListener('click', () => loadMode({ force: true }));
    el('more').addEventListener('click', () => {
      state.visibleRows += PAGE_SIZE;
      renderTable(false);
    });
    el('csv').addEventListener('click', exportCsv);
    el('trackDate').addEventListener('change', () => loadMode());
    el('trackWeekMode').addEventListener('change', () => loadMode());
    el('rankingScope').addEventListener('change', () => loadMode());
    el('rankingHost').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); loadMode(); }
    });
    el('chart').addEventListener('pointerup', handleChartPointer);
    window.addEventListener('resize', () => {
      clearTimeout(state.resizeTimer);
      state.resizeTimer = setTimeout(() => {
        if (!['tracks', 'ranking', 'broadcasts'].includes(state.mode) && state.rows.length) drawChart();
      }, 160);
    }, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) state.controller?.abort();
    });

    const requestedMode = location.hash.slice(1);
    state.mode = MODES[requestedMode] ? requestedMode : 'weekly';
    updateModeUi();
    loadMode();
    void import('/history/history-broadcasts.js');
  }

  start();
})();
