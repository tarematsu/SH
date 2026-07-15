(() => {
  'use strict';

  const PAGE_SIZE = 200;
  const CACHE_PREFIX = 'sh.history-lite.v1:';
  const MAX_CACHE_CHARS = 1_500_000;
  const DAY_MS = 86_400_000;

  const integer = new Intl.NumberFormat('ja-JP');
  const decimal = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
  const dateOnly = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateTime = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const monthDay = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' });

  const MODES = Object.freeze({
    current: {
      title: '現在のデータ', kicker: 'CURRENT',
      help: 'ミニットファクトの直近1440件を表示します。',
      tableTitle: '直近1440件', chartTitle: '現在リスナー推移',
    },
    daily: {
      title: '日次集計', kicker: 'DAILY',
      help: '1日ごとの平均同接、再生数増加、メンバー増加を表示します。',
      tableTitle: '日次集計一覧', chartTitle: '主要指標の推移',
    },
    weekly: {
      title: '週次集計', kicker: 'WEEKLY',
      help: '週ごとの平均同接、再生数増加、メンバー増加を表示します。',
      tableTitle: '週次集計一覧', chartTitle: '主要指標の推移',
    },
    ranking: {
      title: '週間リーダーボード', kicker: 'LEADERBOARD',
      help: 'Stationheadで放送しているホストの週次順位です。掲載がない週は圏外として表示します。',
      tableTitle: '週間リーダーボード', chartTitle: '',
    },
    monthly: {
      title: '月次集計', kicker: 'MONTHLY',
      help: '月ごとの平均同接、再生数増加、メンバー増加を表示します。',
      tableTitle: '月次集計一覧', chartTitle: '主要指標の推移',
    },
    tracks: {
      title: '再生曲', kicker: 'TRACKS',
      help: 'UTC日付（日本時間9:00〜翌8:59）または月曜日始まりの週で再生曲を表示します。',
      tableTitle: '再生曲一覧', chartTitle: '',
    },
    broadcasts: {
      title: '公式ストリーム比較', kicker: 'OFFICIAL STREAMS',
      help: '公式Stationhead放送の同接推移を、各放送の開始を0分として重ねて表示します。',
      tableTitle: '公式ストリーム一覧', chartTitle: '公式ストリーム 同接推移',
    },
  });

  const SUMMARY_COLUMNS = [
    ['period_key', '期間'], ['sample_count', '記録数'], ['reliable_sample_count', '有効記録数'],
    ['listener_avg', '平均同接'], ['listener_min', '最小同接'], ['listener_max', '最大同接'],
    ['stream_start', '再生数（開始）'], ['stream_end', '再生数（終了）'], ['stream_growth', '再生数増加'],
    ['member_start', 'メンバー（開始）'], ['member_end', 'メンバー（終了）'], ['member_growth', 'メンバー増加'],
    ['likes_max', '最大いいね'], ['distinct_tracks', '曲数'], ['primary_host', '主なホスト'], ['quality_score', '品質'],
  ];
  const CURRENT_COLUMNS = [
    ['observed_jst', '観測時刻'], ['source', '取得元'], ['listener_count', '現在リスナー'],
    ['online_member_count', 'オンラインメンバー'], ['total_member_count', '総メンバー'],
    ['total_stream_count', '総再生数'], ['track_title', '曲名'], ['artist_name', 'アーティスト'],
    ['host_handle', 'ホスト'], ['comment_count', 'コメント'], ['quality_score', '品質'],
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

  const SUMMARY_SERIES = [
    ['listener_avg', '平均同接', '--accent', 1, 2.6],
    ['stream_growth', '再生数増加', '--accent-2', 1, 2.6],
    ['listener_min', '最小同接', '--green', .42, 1.25],
    ['listener_max', '最大同接', '--orange', .42, 1.25],
    ['member_growth', 'メンバー増加', '--blue', .42, 1.25],
  ];

  const state = {
    mode: 'weekly',
    rows: [],
    tableRows: [],
    visibleRows: PAGE_SIZE,
    data: null,
    broadcastSeries: [],
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
    const date = Number.isFinite(number) && number > 100_000_000_000 ? new Date(number) : new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDate(value, includeTime = false) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
      const [year, month, day] = String(value).split('-');
      return `${year}/${month}/${day}`;
    }
    const date = parseDate(value);
    return date ? (includeTime ? dateTime : dateOnly).format(date) : String(value || '—');
  }

  function rowDate(row) {
    return row?.period_key || row?.ranking_date || row?.started_jst || row?.observed_jst || row?.observed_at || '';
  }

  function timestamp(value) {
    return parseDate(value)?.getTime() ?? null;
  }

  function setText(id, value) {
    const node = el(id);
    if (node && node.textContent !== String(value)) node.textContent = String(value);
  }

  function setNotice(message, error = false) {
    const notice = el('notice');
    notice.textContent = message;
    notice.classList.toggle('error', error);
  }

  function cacheKey(url) {
    return `${CACHE_PREFIX}${url}`;
  }

  function readCache(url, ttl) {
    try {
      const cached = JSON.parse(sessionStorage.getItem(cacheKey(url)) || 'null');
      if (!cached || Date.now() - Number(cached.at || 0) > ttl) return null;
      return cached.data;
    } catch {
      return null;
    }
  }

  function writeCache(url, data) {
    try {
      const value = JSON.stringify({ at: Date.now(), data });
      if (value.length <= MAX_CACHE_CHARS) sessionStorage.setItem(cacheKey(url), value);
    } catch {
      // The page remains usable when storage is unavailable or full.
    }
  }

  async function fetchJson(url, { ttl, signal, force = false } = {}) {
    if (force) sessionStorage.removeItem(cacheKey(url));
    const cached = !force ? readCache(url, ttl) : null;
    if (cached) return { data: cached, cached: true };
    const response = await fetch(url, { signal, headers: { accept: 'application/json' } });
    const data = await response.json();
    if (!response.ok || !data?.ok) throw new Error(data?.error || `API ${response.status}`);
    writeCache(url, data);
    return { data, cached: false };
  }

  function mondayOf(value) {
    const date = new Date(`${value || todayUtc()}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString().slice(0, 10);
  }

  function sundayOf(value) {
    const date = new Date(`${mondayOf(value)}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 6);
    return date.toISOString().slice(0, 10);
  }

  function applyPreset(days) {
    const to = todayJst();
    el('to').value = to;
    if (days === 'all') el('from').value = '2024-05-01';
    else {
      const from = new Date(Date.now() - Number(days) * DAY_MS);
      el('from').value = from.toISOString().slice(0, 10);
    }
    document.querySelectorAll('#rangePresets button').forEach((button) => {
      button.classList.toggle('active', button.dataset.days === String(days));
    });
  }

  function columnsFor(mode) {
    if (mode === 'current') return CURRENT_COLUMNS;
    if (mode === 'tracks') return TRACK_COLUMNS;
    if (mode === 'broadcasts') return BROADCAST_COLUMNS;
    if (mode === 'ranking') return RANKING_COLUMNS;
    return SUMMARY_COLUMNS;
  }

  function displayCell(key, row, mode) {
    const value = row?.[key];
    if (mode === 'ranking') {
      if (key === 'ranking_date') return formatDate(value);
      if (key === 'rank') return row.is_out_of_rank || value == null ? '圏外' : `${numberText(value)}位`;
      if (key === 'previous_rank') {
        if (row.previous_out_of_rank) return '圏外';
        return value == null ? '—' : `${numberText(value)}位`;
      }
      if (key === 'rank_change') {
        const change = finite(value);
        return change == null || change === 0 ? '—' : change > 0 ? `↑${numberText(change)}` : `↓${numberText(Math.abs(change))}`;
      }
    }
    if (mode === 'tracks') {
      if (key === 'play_date') return formatDate(value);
      if (key === 'play_count') return value == null ? '—' : `${numberText(value)}回`;
      if (key === 'daily_share') return value == null ? '—' : `${numberText(value)}%`;
      if (key === 'like_count') return row._daily_total || value == null ? '—' : `${integer.format(Number(value))}件`;
      if (key === 'first_played_at' || key === 'last_played_at') return row._daily_total ? '—' : formatDate(value, true);
    }
    if (key.includes('date') || key.includes('jst') || key === 'period_key' || key === 'observed_jst') {
      return formatDate(value, key.includes('jst') || key === 'observed_jst');
    }
    if (typeof value === 'number') return numberText(value);
    return value === null || value === undefined || value === '' ? '—' : String(value);
  }

  function trackRowsWithTotals(rows) {
    const totals = new Map();
    for (const row of rows) totals.set(row.play_date, (totals.get(row.play_date) || 0) + (finite(row.play_count) || 0));
    const result = [];
    let previousDate = null;
    for (const row of rows) {
      const total = totals.get(row.play_date) || 0;
      if (row.play_date !== previousDate) {
        result.push({
          _daily_total: true, play_date: row.play_date, title: 'この日の延べ曲数', artist: '—',
          play_count: total, daily_share: 100, like_count: null, first_played_at: null, last_played_at: null,
        });
        previousDate = row.play_date;
      }
      result.push({ ...row, daily_share: total > 0 ? (finite(row.play_count) || 0) / total * 100 : 0 });
    }
    return result;
  }

  function tableOrder(rows, mode) {
    if (mode === 'tracks') return trackRowsWithTotals(rows);
    if (['current', 'daily', 'weekly', 'monthly', 'broadcasts'].includes(mode)) return [...rows].reverse();
    return rows;
  }

  function renderTable(reset = true) {
    const columns = columnsFor(state.mode);
    if (reset) state.visibleRows = PAGE_SIZE;
    const head = el('thead');
    const body = el('tbody');
    head.replaceChildren();
    body.replaceChildren();

    const headerRow = document.createElement('tr');
    for (const [, label] of columns) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      headerRow.appendChild(cell);
    }
    head.appendChild(headerRow);

    const visible = state.tableRows.slice(0, state.visibleRows);
    if (!visible.length) {
      const row = document.createElement('tr');
      row.className = 'empty-row';
      const cell = document.createElement('td');
      cell.colSpan = columns.length;
      cell.textContent = '表示できるデータがありません。';
      row.appendChild(cell);
      body.appendChild(row);
    } else {
      const fragment = document.createDocumentFragment();
      for (const rowData of visible) {
        const row = document.createElement('tr');
        if (rowData._daily_total) row.classList.add('daily-total-row');
        if (rowData.period_complete === false || rowData.play_count_excluded === true) row.classList.add('incomplete-row');
        for (const [key] of columns) {
          const cell = document.createElement('td');
          cell.textContent = displayCell(key, rowData, state.mode);
          if (state.mode === 'ranking' && key === 'rank_change') {
            const change = finite(rowData.rank_change);
            if (change > 0) cell.className = 'rank-up';
            if (change < 0) cell.className = 'rank-down';
          }
          row.appendChild(cell);
        }
        fragment.appendChild(row);
      }
      body.appendChild(fragment);
    }

    const more = el('more');
    more.hidden = state.visibleRows >= state.tableRows.length;
    more.textContent = `さらに表示（残り${integer.format(Math.max(0, state.tableRows.length - state.visibleRows))}件）`;
  }

  function setSummary(labels, values) {
    setText('periodLabel', labels[0]);
    setText('maxLabel', labels[1]);
    setText('streamLabel', labels[2]);
    setText('memberLabel', labels[3]);
    setText('periods', values[0]);
    setText('maxListener', values[1]);
    setText('streamGrowth', values[2]);
    setText('memberGrowth', values[3]);
  }

  function durationText(milliseconds) {
    const value = finite(milliseconds);
    if (value == null || value < 0) return '—';
    const minutes = Math.round(value / 60_000);
    if (minutes < 60) return `${minutes}分`;
    const hours = Math.floor(minutes / 60);
    return minutes % 60 ? `${hours}時間${minutes % 60}分` : `${hours}時間`;
  }

  function updateSummary() {
    const rows = state.rows;
    if (state.mode === 'current') {
      const latest = rows.at(-1) || {};
      setSummary(
        ['表示件数', '最新リスナー', '最新総再生数', '最新メンバー'],
        [numberText(rows.length), numberText(latest.listener_count), numberText(latest.total_stream_count), numberText(latest.total_member_count)],
      );
      return;
    }
    if (['daily', 'weekly', 'monthly'].includes(state.mode)) {
      const sums = { listener: 0, listenerCount: 0, stream: 0, streamCount: 0, member: 0, memberCount: 0 };
      for (const row of rows) {
        const listener = finite(row.listener_avg);
        const stream = finite(row.stream_growth);
        const member = finite(row.member_growth);
        if (listener != null) { sums.listener += listener; sums.listenerCount += 1; }
        if (stream != null) { sums.stream += stream; sums.streamCount += 1; }
        if (member != null) { sums.member += member; sums.memberCount += 1; }
      }
      const period = { daily: '日平均', weekly: '週平均', monthly: '月平均' }[state.mode];
      setSummary(
        ['期間数', `平均同接（${period}）`, `再生数増加（${period}）`, `メンバー増加（${period}）`],
        [
          numberText(rows.length),
          sums.listenerCount ? numberText(sums.listener / sums.listenerCount) : '—',
          sums.streamCount ? numberText(sums.stream / sums.streamCount) : '—',
          sums.memberCount ? numberText(sums.member / sums.memberCount) : '—',
        ],
      );
      return;
    }
    if (state.mode === 'tracks') {
      const validRows = rows.filter((row) => row.period_complete !== false && row.play_count_excluded !== true);
      const days = new Set(validRows.map((row) => row.play_date).filter(Boolean));
      const tracks = new Set(validRows.map((row) => row.track_key || row.spotify_id || row.isrc || `${row.title}:${row.artist}`).filter(Boolean));
      let total = 0;
      let maximum = 0;
      for (const row of validRows) {
        const count = finite(row.play_count) || 0;
        total += count;
        maximum = Math.max(maximum, count);
      }
      setSummary(
        ['有効日数', '総再生回数', '曲数', '1曲の最多'],
        [numberText(days.size), days.size ? numberText(total) : '—', days.size ? numberText(tracks.size) : '—', maximum ? `${numberText(maximum)}回` : '—'],
      );
      return;
    }
    if (state.mode === 'ranking') {
      const ranks = rows.map((row) => finite(row.rank)).filter((value) => value != null);
      setSummary(
        ['表示行数', '最高順位', '掲載ホスト', '掲載週'],
        [
          numberText(rows.length), ranks.length ? `${numberText(Math.min(...ranks))}位` : '—',
          numberText(new Set(rows.map((row) => row.host_name).filter(Boolean)).size),
          numberText(new Set(rows.map((row) => row.ranking_date).filter(Boolean)).size),
        ],
      );
      return;
    }
    if (state.mode === 'broadcasts') {
      let minimum = null;
      let maximum = null;
      let weightedTotal = 0;
      let weightedCount = 0;
      let durationTotal = 0;
      let durationCount = 0;
      for (const row of rows) {
        const min = finite(row.listener_min);
        const max = finite(row.listener_max);
        const average = finite(row.listener_avg);
        const samples = finite(row.sample_count);
        if (min != null) minimum = minimum == null ? min : Math.min(minimum, min);
        if (max != null) maximum = maximum == null ? max : Math.max(maximum, max);
        if (average != null) {
          const weight = samples != null && samples > 0 ? samples : 1;
          weightedTotal += average * weight;
          weightedCount += weight;
        }
        const start = finite(row.started_at);
        const end = finite(row.ended_at);
        if (start != null && end != null && end >= start) {
          durationTotal += end - start;
          durationCount += 1;
        }
      }
      setSummary(
        ['最小同接', '最大同接', '平均同接', '平均放送時間'],
        [numberText(minimum), numberText(maximum), weightedCount ? numberText(weightedTotal / weightedCount) : '—', durationCount ? durationText(durationTotal / durationCount) : '—'],
      );
    }
  }

  function renderRankingWeekly(rows) {
    const panel = el('rankingWeeklyPanel');
    panel.hidden = state.mode !== 'ranking';
    if (panel.hidden) return;
    const columns = [
      ['ranking_date', '週'], ['stream_growth', '週間再生数'], ['member_growth', '週間メンバー増加'],
      ['listener_avg', '平均同接'], ['listener_min', '最小同接'], ['listener_max', '最大同接'],
    ];
    const head = el('rankingWeeklyThead');
    const body = el('rankingWeeklyTbody');
    head.replaceChildren();
    body.replaceChildren();
    const header = document.createElement('tr');
    for (const [, label] of columns) {
      const cell = document.createElement('th');
      cell.textContent = label;
      header.appendChild(cell);
    }
    head.appendChild(header);
    for (const rowData of rows || []) {
      const row = document.createElement('tr');
      for (const [key] of columns) {
        const cell = document.createElement('td');
        cell.textContent = key === 'ranking_date' ? formatDate(rowData[key]) : numberText(rowData[key]);
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
    if (!body.children.length) {
      const row = document.createElement('tr');
      row.className = 'empty-row';
      const cell = document.createElement('td');
      cell.colSpan = columns.length;
      cell.textContent = '参考データがありません。';
      row.appendChild(cell);
      body.appendChild(row);
    }
  }

  function cssColor(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  function prepareCanvas() {
    const canvas = el('chart');
    const bounds = canvas.getBoundingClientRect();
    const width = Math.max(300, Math.round(bounds.width || 900));
    const height = Math.max(240, Math.min(380, Math.round(width * .42)));
    const ratio = Math.min(1.75, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    return { canvas, context, width, height };
  }

  function sampleRows(rows, maximum = 240) {
    if (rows.length <= maximum) return rows;
    const step = (rows.length - 1) / (maximum - 1);
    return Array.from({ length: maximum }, (_, index) => rows[Math.round(index * step)]);
  }

  function positionsFromTimes(times, area) {
    const valid = times.filter((value) => value != null);
    const minimum = valid.length ? Math.min(...valid) : 0;
    const maximum = valid.length ? Math.max(...valid) : 0;
    const span = maximum - minimum;
    return times.map((time, index) => valid.length >= 2 && span > 0 && time != null
      ? area.left + area.width * (time - minimum) / span
      : area.left + area.width * index / Math.max(1, times.length - 1));
  }

  function drawGrid(context, width, height, area) {
    context.lineWidth = 1;
    context.strokeStyle = 'rgba(31,45,68,.10)';
    for (let index = 0; index <= 4; index += 1) {
      const y = area.top + area.height * index / 4;
      context.beginPath();
      context.moveTo(area.left, y);
      context.lineTo(width - area.right, y);
      context.stroke();
    }
  }

  function drawDateAxis(context, dates, positions, width, height, area) {
    if (!dates.length) return;
    const first = timestamp(dates[0]);
    const last = timestamp(dates.at(-1));
    const spanDays = first != null && last != null ? Math.abs(last - first) / DAY_MS : 0;
    const count = Math.max(3, Math.min(9, Math.floor(area.width / 80)));
    context.fillStyle = cssColor('--muted', '#667287');
    context.font = '10.5px system-ui';
    context.textBaseline = 'top';
    for (let tick = 0; tick < count; tick += 1) {
      const index = Math.round((dates.length - 1) * tick / Math.max(1, count - 1));
      const raw = dates[index];
      const date = parseDate(raw);
      const label = state.mode === 'monthly' || spanDays > 730
        ? String(raw || '').slice(0, 7).replace('-', '/')
        : date ? (spanDays > 120 ? dateOnly : monthDay).format(date) : String(raw || '').slice(0, 10);
      const measured = context.measureText(label).width;
      const x = Math.max(area.left, Math.min(width - area.right - measured, positions[index] - measured / 2));
      context.fillText(label, x, height - area.bottom + 11);
    }
  }

  function setChartRange(dates, startPrefix = '', endPrefix = '') {
    const valid = dates.filter(Boolean);
    setText('chartStartDate', valid.length ? `${startPrefix}${formatDate(valid[0])}` : '—');
    setText('chartEndDate', valid.length ? `${endPrefix}${formatDate(valid.at(-1))}` : '—');
  }

  function legendItem(label, color, opacity = 1) {
    const item = document.createElement('span');
    item.style.opacity = String(opacity);
    const dot = document.createElement('i');
    dot.style.background = color;
    item.append(dot, document.createTextNode(label));
    return item;
  }

  function renderDetail(title, rows) {
    const detail = el('chartDetail');
    detail.replaceChildren();
    const time = document.createElement('time');
    time.textContent = title;
    const values = document.createElement('div');
    values.className = 'detail-values';
    for (const item of rows) {
      const row = document.createElement('div');
      row.className = 'detail-row';
      const dot = document.createElement('i');
      dot.style.background = item.color;
      const label = document.createElement('strong');
      label.textContent = item.label;
      const value = document.createElement('span');
      value.textContent = item.value;
      row.append(dot, label, value);
      values.appendChild(row);
    }
    detail.append(time, values);
  }

  function drawEmpty(message = '表示できるグラフデータがありません。') {
    const { context, width, height } = prepareCanvas();
    context.fillStyle = cssColor('--muted', '#667287');
    context.font = '14px system-ui';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(message, width / 2, height / 2);
    state.chartModel = null;
    el('chartLegend').replaceChildren();
    setText('chartStartDate', '—');
    setText('chartEndDate', '—');
    el('chartDetail').textContent = '表示できるグラフデータがありません。';
  }

  function drawSummaryChart() {
    const sorted = [...state.rows].sort((left, right) => (timestamp(rowDate(left)) || 0) - (timestamp(rowDate(right)) || 0));
    const rows = sampleRows(sorted);
    if (!rows.length) return drawEmpty();
    const { context, width, height } = prepareCanvas();
    const area = { left: 26, right: 18, top: 18, bottom: 42 };
    area.width = width - area.left - area.right;
    area.height = height - area.top - area.bottom;
    drawGrid(context, width, height, area);
    const dates = rows.map(rowDate);
    const times = dates.map(timestamp);
    const positions = positionsFromTimes(times, area);
    drawDateAxis(context, dates, positions, width, height, area);

    const series = SUMMARY_SERIES.map(([key, label, variable, opacity, lineWidth]) => {
      const values = rows.map((row) => finite(row[key]));
      const valid = values.filter((value) => value != null);
      return {
        key, label, opacity, lineWidth, values,
        color: cssColor(variable, '#d93f79'),
        minimum: valid.length ? Math.min(...valid) : 0,
        maximum: valid.length ? Math.max(...valid) : 1,
        active: valid.length > 0,
      };
    }).filter((item) => item.active);
    if (!series.length) return drawEmpty();

    for (const item of series) {
      const range = item.maximum - item.minimum || 1;
      context.save();
      context.globalAlpha = item.opacity;
      context.strokeStyle = item.color;
      context.lineWidth = item.lineWidth;
      context.lineJoin = 'round';
      context.lineCap = 'round';
      context.beginPath();
      let open = false;
      item.values.forEach((value, index) => {
        if (value == null) { open = false; return; }
        const x = positions[index];
        const y = area.top + area.height - (value - item.minimum) / range * area.height;
        const previous = index > 0 ? times[index - 1] : null;
        const current = times[index];
        const gapDays = previous != null && current != null ? (current - previous) / DAY_MS : 0;
        const threshold = state.mode === 'daily' ? 1.5 : state.mode === 'monthly' ? 45 : 10;
        if (!open || gapDays > threshold) context.moveTo(x, y);
        else context.lineTo(x, y);
        open = true;
      });
      context.stroke();
      context.restore();
    }

    if (Number.isInteger(state.selectedChartIndex) && rows[state.selectedChartIndex]) {
      const x = positions[state.selectedChartIndex];
      context.save();
      context.strokeStyle = 'rgba(23,32,51,.55)';
      context.setLineDash([4, 4]);
      context.beginPath();
      context.moveTo(x, area.top);
      context.lineTo(x, area.top + area.height);
      context.stroke();
      context.restore();
      const row = rows[state.selectedChartIndex];
      renderDetail(formatDate(dates[state.selectedChartIndex]), series.map((item) => ({
        label: item.label, color: item.color, value: numberText(row[item.key]),
      })));
    } else {
      el('chartDetail').textContent = 'グラフをタッチすると、その時点の詳細を表示します。';
    }

    el('chartLegend').replaceChildren(...series.map((item) => legendItem(item.label, item.color, item.opacity)));
    setChartRange(dates);
    state.chartModel = { type: 'summary', positions, rows };
  }

  function drawCurrentChart() {
    const rows = sampleRows([...state.rows].sort((left, right) => Number(left.observed_at || 0) - Number(right.observed_at || 0)), 300);
    const values = rows.map((row) => finite(row.listener_count));
    const valid = values.filter((value) => value != null);
    if (!rows.length || !valid.length) return drawEmpty();
    const { context, width, height } = prepareCanvas();
    const area = { left: 48, right: 18, top: 18, bottom: 42 };
    area.width = width - area.left - area.right;
    area.height = height - area.top - area.bottom;
    drawGrid(context, width, height, area);
    const dates = rows.map((row) => row.observed_at);
    const times = dates.map((value) => finite(value));
    const positions = positionsFromTimes(times, area);
    const minimumRaw = Math.min(...valid);
    const maximumRaw = Math.max(...valid);
    const padding = Math.max(3, (maximumRaw - minimumRaw) * .08);
    const minimum = Math.max(0, minimumRaw - padding);
    const maximum = maximumRaw + padding;
    const range = maximum - minimum || 1;
    const color = cssColor('--accent', '#d93f79');

    context.fillStyle = cssColor('--muted', '#667287');
    context.font = '10.5px system-ui';
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    for (let index = 0; index <= 4; index += 1) {
      const y = area.top + area.height * index / 4;
      context.fillText(numberText(maximum - range * index / 4), area.left - 7, y);
    }
    drawDateAxis(context, dates, positions, width, height, area);
    context.strokeStyle = color;
    context.lineWidth = 2.4;
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.beginPath();
    let open = false;
    values.forEach((value, index) => {
      if (value == null) { open = false; return; }
      const x = positions[index];
      const y = area.top + area.height - (value - minimum) / range * area.height;
      if (!open) context.moveTo(x, y);
      else context.lineTo(x, y);
      open = true;
    });
    context.stroke();

    if (Number.isInteger(state.selectedChartIndex) && rows[state.selectedChartIndex]) {
      const x = positions[state.selectedChartIndex];
      context.save();
      context.strokeStyle = 'rgba(23,32,51,.55)';
      context.setLineDash([4, 4]);
      context.beginPath();
      context.moveTo(x, area.top);
      context.lineTo(x, area.top + area.height);
      context.stroke();
      context.restore();
      const row = rows[state.selectedChartIndex];
      renderDetail(formatDate(row.observed_at, true), [
        { label: '現在リスナー', color, value: `${numberText(row.listener_count)}人` },
        { label: 'オンラインメンバー', color: cssColor('--accent-2', '#6657d8'), value: numberText(row.online_member_count) },
        { label: '総再生数', color: cssColor('--blue', '#2776b9'), value: numberText(row.total_stream_count) },
      ]);
    } else {
      el('chartDetail').textContent = 'グラフをタッチすると、その時点の詳細を表示します。';
    }
    el('chartLegend').replaceChildren(legendItem('現在リスナー', color));
    setChartRange(dates);
    state.chartModel = { type: 'current', positions, rows };
  }

  function sampleBroadcastPoints(points, maximum = 1200) {
    if (!Array.isArray(points) || points.length <= maximum) return points || [];
    const step = (points.length - 1) / (maximum - 1);
    return Array.from({ length: maximum }, (_, index) => points[Math.round(index * step)]);
  }

  function broadcastColor(index, alpha = 1) {
    const hue = (330 + index * 137.508) % 360;
    return `hsla(${hue},70%,48%,${alpha})`;
  }

  function elapsedText(minutes) {
    const value = Math.max(0, Math.round(Number(minutes) || 0));
    if (value < 60) return `${value}分`;
    return value % 60 ? `${Math.floor(value / 60)}時間${value % 60}分` : `${Math.floor(value / 60)}時間`;
  }

  function broadcastLabel(item) {
    const started = finite(item.started_at);
    return started != null ? `${monthDay.format(new Date(started))} ${item.event_name || '公式ストリーム'}` : item.event_name || '公式ストリーム';
  }

  function nearestBroadcastPoint(points, minute) {
    if (!points?.length) return null;
    let best = null;
    let distance = Infinity;
    for (const point of points) {
      const next = Math.abs(Number(point?.[0]) - minute);
      if (next < distance) { distance = next; best = point; }
    }
    return distance <= 5 ? best : null;
  }

  function drawBroadcastChart() {
    const series = state.broadcastSeries.filter((item) => Array.isArray(item.points) && item.points.length);
    if (!series.length) return drawEmpty('表示できる公式ストリームデータがありません。');
    const { canvas, context, width, height } = prepareCanvas();
    const area = { left: 48, right: 18, top: 18, bottom: 42 };
    area.width = width - area.left - area.right;
    area.height = height - area.top - area.bottom;
    let maxMinute = 1;
    let maxListenerRaw = 1;
    for (const item of series) {
      for (const point of item.points) {
        maxMinute = Math.max(maxMinute, finite(point?.[0]) || 0);
        maxListenerRaw = Math.max(maxListenerRaw, finite(point?.[1]) || 0);
      }
    }
    const maxListener = Math.ceil(maxListenerRaw / 50) * 50 || 50;
    const xFor = (minute) => area.left + area.width * Math.max(0, Number(minute) || 0) / maxMinute;
    const yFor = (value) => area.top + area.height - area.height * Math.max(0, Number(value) || 0) / maxListener;
    drawGrid(context, width, height, area);
    context.fillStyle = cssColor('--muted', '#667287');
    context.font = '10.5px system-ui';
    context.textBaseline = 'middle';
    context.textAlign = 'right';
    for (let index = 0; index <= 4; index += 1) {
      const ratio = index / 4;
      context.fillText(numberText(Math.round(maxListener * (1 - ratio))), area.left - 7, area.top + area.height * ratio);
    }
    context.textAlign = 'center';
    context.textBaseline = 'top';
    const ticks = Math.max(3, Math.min(8, Math.floor(area.width / 90)));
    for (let index = 0; index < ticks; index += 1) {
      const minute = maxMinute * index / Math.max(1, ticks - 1);
      context.fillText(elapsedText(minute), xFor(minute), height - area.bottom + 11);
    }

    series.forEach((item, index) => {
      context.strokeStyle = broadcastColor(index, series.length > 12 ? .68 : .9);
      context.lineWidth = series.length > 16 ? 1.15 : 1.7;
      context.lineJoin = 'round';
      context.lineCap = 'round';
      context.beginPath();
      let open = false;
      for (const point of sampleBroadcastPoints(item.points)) {
        const minute = finite(point?.[0]);
        const value = finite(point?.[1]);
        if (minute == null || value == null) { open = false; continue; }
        if (!open) context.moveTo(xFor(minute), yFor(value));
        else context.lineTo(xFor(minute), yFor(value));
        open = true;
      }
      context.stroke();
    });

    const selectedMinute = finite(state.selectedChartIndex);
    if (selectedMinute != null) {
      const x = xFor(selectedMinute);
      context.save();
      context.strokeStyle = 'rgba(23,32,51,.55)';
      context.setLineDash([4, 4]);
      context.beginPath();
      context.moveTo(x, area.top);
      context.lineTo(x, area.top + area.height);
      context.stroke();
      context.restore();
      renderDetail(`開始から ${elapsedText(selectedMinute)}`, series.map((item, index) => {
        const point = nearestBroadcastPoint(item.points, selectedMinute);
        return point ? { label: broadcastLabel(item), color: broadcastColor(index), value: `${numberText(point[1])}人` } : null;
      }).filter(Boolean));
    } else {
      el('chartDetail').textContent = 'グラフをタッチすると、開始後の同じ時点で全放送を比較できます。';
    }

    el('chartLegend').replaceChildren(...series.map((item, index) => legendItem(broadcastLabel(item), broadcastColor(index))));
    setText('chartStartDate', '開始 0分');
    setText('chartEndDate', `最長 ${elapsedText(maxMinute)}`);
    canvas.dataset.left = String(area.left);
    canvas.dataset.chartWidth = String(area.width);
    canvas.dataset.maxMinute = String(maxMinute);
    state.chartModel = { type: 'broadcast', series, maxMinute, area };
  }

  function drawChart() {
    if (['tracks', 'ranking'].includes(state.mode)) return;
    if (state.mode === 'current') drawCurrentChart();
    else if (state.mode === 'broadcasts') drawBroadcastChart();
    else drawSummaryChart();
  }

  function handleChartPointer(event) {
    if (!state.chartModel) return;
    const canvas = el('chart');
    const bounds = canvas.getBoundingClientRect();
    const pointer = event.clientX - bounds.left;
    if (state.chartModel.type === 'broadcast') {
      const left = Number(canvas.dataset.left) || 48;
      const chartWidth = Number(canvas.dataset.chartWidth) || Math.max(1, bounds.width - 66);
      const maxMinute = Number(canvas.dataset.maxMinute) || 1;
      state.selectedChartIndex = Math.max(0, Math.min(maxMinute, (pointer - left) / chartWidth * maxMinute));
      drawBroadcastChart();
      return;
    }
    const positions = state.chartModel.positions;
    let nearest = 0;
    let distance = Infinity;
    positions.forEach((position, index) => {
      const next = Math.abs(position - pointer);
      if (next < distance) { distance = next; nearest = index; }
    });
    state.selectedChartIndex = nearest;
    drawChart();
  }

  function updateModeUi() {
    const config = MODES[state.mode];
    document.querySelectorAll('#modeTabs button').forEach((button) => {
      const active = button.dataset.mode === state.mode;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    setText('guideTitle', config.title);
    setText('guideText', config.help);
    el('guide').querySelector('.kicker').textContent = config.kicker;
    setText('tableTitle', config.tableTitle);
    setText('chartTitle', config.chartTitle || '');

    const noControls = ['current', 'broadcasts'].includes(state.mode);
    el('controls').hidden = noControls;
    el('standardControls').hidden = ['tracks'].includes(state.mode);
    el('trackControls').hidden = state.mode !== 'tracks';
    el('rankingControls').hidden = state.mode !== 'ranking';
    el('chartPanel').hidden = ['tracks', 'ranking'].includes(state.mode);
    el('rankingWeeklyPanel').hidden = state.mode !== 'ranking';
    el('chartFoot').textContent = state.mode === 'broadcasts'
      ? '横軸は各放送の開始からの経過時間です。'
      : state.mode === 'current'
        ? '直近1440件のミニットファクトを時系列で表示します。'
        : '平均同接と再生数増加を強調表示。各指標は個別スケールです。';
    state.selectedChartIndex = null;
    state.chartModel = null;
  }

  function resetData() {
    state.rows = [];
    state.tableRows = [];
    state.data = null;
    state.broadcastSeries = [];
    state.visibleRows = PAGE_SIZE;
    el('tbody').replaceChildren();
    el('chartLegend').replaceChildren();
    el('rankingWeeklyPanel').hidden = state.mode !== 'ranking';
  }

  function renderLoadedData() {
    updateSummary();
    state.tableRows = tableOrder(state.rows, state.mode);
    renderTable(true);
    renderRankingWeekly(state.data?.weekly_metrics || []);
    if (!['tracks', 'ranking'].includes(state.mode)) requestAnimationFrame(drawChart);
  }

  function normalizeCurrentRows(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => ({ ...row, observed_jst: row.observed_at }));
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

      if (mode === 'current') {
        ({ data, cached } = await fetchJson('/api/history-current?latest=1', {
          ttl: 60_000, signal: controller.signal, force,
        }));
        if (token !== state.requestToken || state.mode !== mode) return;
        state.data = data;
        state.rows = normalizeCurrentRows(data.rows);
        const latest = data.latest_live || data.latest_any;
        setNotice(`${numberText(state.rows.length)}件を表示 · 最新 ${formatDate(latest?.observed_at, true)}${cached ? ' · キャッシュ' : ''}`);
      } else if (mode === 'tracks') {
        const url = `/api/track-history?${new URLSearchParams({ from, to, limit: '2000', likes: '1' })}`;
        ({ data, cached } = await fetchJson(url, { ttl: 10 * 60_000, signal: controller.signal, force }));
        if (token !== state.requestToken || state.mode !== mode) return;
        state.data = data;
        state.rows = Array.isArray(data.rows) ? data.rows : [];
        const suffix = data.truncated ? ' · 表示上限' : '';
        setNotice(`${formatDate(from)}〜${formatDate(to)} · ${numberText(state.rows.length)}件 · ${data.timezone || 'UTC'}${suffix}${cached ? ' · キャッシュ' : ''}`);
      } else if (mode === 'ranking') {
        const params = new URLSearchParams({ mode, from, to, scope: el('rankingScope').value, limit: '5000' });
        const host = el('rankingHost').value.trim();
        if (host) params.set('host', host);
        const url = `/api/history?${params}`;
        ({ data, cached } = await fetchJson(url, { ttl: 5 * 60_000, signal: controller.signal, force }));
        if (token !== state.requestToken || state.mode !== mode) return;
        state.data = data;
        state.rows = Array.isArray(data.rows) ? data.rows : [];
        const scope = host ? `「${host}」を検索` : el('rankingScope').value === 'featured' ? '櫻坂' : '全ホスト';
        setNotice(`${scope} · ${numberText(state.rows.length)}行${data.truncated ? ' · 最大5000件' : ''}${cached ? ' · キャッシュ' : ''}`);
      } else if (mode === 'broadcasts') {
        const historyUrl = `/api/history?${new URLSearchParams({ mode, from, to })}`;
        const seriesUrl = `/api/broadcast-series?${new URLSearchParams({ from, to })}`;
        const [historyResult, seriesResult] = await Promise.all([
          fetchJson(historyUrl, { ttl: 15 * 60_000, signal: controller.signal, force }),
          fetchJson(seriesUrl, { ttl: 60 * 60_000, signal: controller.signal, force }),
        ]);
        if (token !== state.requestToken || state.mode !== mode) return;
        data = historyResult.data;
        state.data = data;
        state.rows = Array.isArray(data.rows) ? data.rows : [];
        state.broadcastSeries = Array.isArray(seriesResult.data.series) ? seriesResult.data.series : [];
        setNotice(`${numberText(state.rows.length)}件 · 全${numberText(seriesResult.data.event_count || state.broadcastSeries.length)}放送を比較${historyResult.cached && seriesResult.cached ? ' · キャッシュ' : ''}`);
      } else {
        const url = `/api/history?${new URLSearchParams({ mode, from, to })}`;
        ({ data, cached } = await fetchJson(url, { ttl: 5 * 60_000, signal: controller.signal, force }));
        if (token !== state.requestToken || state.mode !== mode) return;
        state.data = data;
        state.rows = Array.isArray(data.rows) ? data.rows : [];
        const latest = data.latest_live_observed_at ? ` · 最新 ${formatDate(data.latest_live_observed_at, true)}` : '';
        setNotice(`${numberText(state.rows.length)}期間を表示${latest}${cached ? ' · キャッシュ' : ''}`);
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
    const rows = state.rows;
    const lines = [
      columns.map(([, label]) => label),
      ...rows.map((row) => columns.map(([key]) => displayCell(key, row, state.mode))),
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
    document.querySelectorAll('#modeTabs button').forEach((button) => {
      button.addEventListener('click', () => setMode(button.dataset.mode));
    });
    document.querySelectorAll('#rangePresets button').forEach((button) => {
      button.addEventListener('click', () => {
        applyPreset(button.dataset.days);
        loadMode();
      });
    });
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
        if (!['tracks', 'ranking'].includes(state.mode) && state.rows.length) drawChart();
      }, 160);
    }, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) state.controller?.abort();
      else if (state.mode === 'current') loadMode();
    });
    setInterval(() => {
      if (!document.hidden && state.mode === 'current') loadMode();
    }, 60_000);

    const requestedMode = location.hash.slice(1);
    state.mode = MODES[requestedMode] ? requestedMode : 'weekly';
    updateModeUi();
    loadMode();
  }

  start();
})();
