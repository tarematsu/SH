(() => {
  const nativeFetch = window.fetch.bind(window);
  const cacheablePaths = new Set(['/api/track-history', '/api/history', '/api/broadcast-series']);
  const numberFormatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
  const dateFormatter = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const xPositionCache = new WeakMap();
  const dateAxisCache = new WeakMap();

  function boundaryCacheKey(key) {
    return String(key || '')
      .replace(/^track-history:v12:/, 'track-history:v13:')
      .replace(/^history:v10:/, 'history:v11:');
  }

  if (typeof readCache === 'function' && typeof writeCache === 'function') {
    const previousReadCache = readCache;
    const previousWriteCache = writeCache;
    readCache = function readBoundaryCache(key) {
      return previousReadCache(boundaryCacheKey(key));
    };
    writeCache = function writeBoundaryCache(key, data) {
      return previousWriteCache(boundaryCacheKey(key), data);
    };
  }

  function numberText(value) {
    const number = finiteNumber(value);
    return number == null ? '—' : numberFormatter.format(number);
  }

  function setText(selector, value) {
    const node = $(selector);
    const text = String(value ?? '');
    if (node && node.textContent !== text) node.textContent = text;
  }

  function setHtml(selector, value) {
    const node = $(selector);
    if (node && node.innerHTML !== value) node.innerHTML = value;
  }

  formatDate = function formatDateWithSharedFormatter(value, includeTime = false) {
    if (!value) return '—';
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const [year, month, day] = text.split('-');
      return `${year}/${month}/${day}`;
    }
    const numeric = Number(value);
    const date = Number.isFinite(numeric) && numeric > 100000000000 ? new Date(numeric) : new Date(text);
    if (Number.isNaN(date.getTime())) return text;
    return (includeTime ? dateTimeFormatter : dateFormatter).format(date);
  };

  prepareCanvas = function prepareCanvasDifferential() {
    const canvas = $('#chart');
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const width = canvas.clientWidth || 1000;
    const height = canvas.clientHeight || 330;
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  };

  resetChartInfo = function resetChartInfoDifferential() {
    setText('#chartStartDate', '—');
    setText('#chartEndDate', '—');
    setHtml('#chartDetail', '<span>グラフをタッチまたはクリックすると、その時点の詳細を表示します。</span>');
  };

  setChartRange = function setChartRangeSinglePass(dates) {
    let first = null;
    let last = null;
    for (const value of dates || []) {
      if (!value) continue;
      if (first == null) first = value;
      last = value;
    }
    setText('#chartStartDate', first == null ? '—' : formatDate(first));
    setText('#chartEndDate', last == null ? '—' : formatDate(last));
  };

  makeXPositions = function makeXPositionsCached(dates, area) {
    const values = Array.isArray(dates) ? dates : [];
    const cacheKey = `${area.left}:${area.width}`;
    const cached = xPositionCache.get(values);
    if (cached?.cacheKey === cacheKey) return cached.positions;

    const times = new Array(values.length);
    let minimum = Infinity;
    let maximum = -Infinity;
    let validCount = 0;
    for (let index = 0; index < values.length; index += 1) {
      const time = dateTimestamp(values[index]);
      times[index] = time;
      if (time == null) continue;
      validCount += 1;
      minimum = Math.min(minimum, time);
      maximum = Math.max(maximum, time);
    }

    const positions = new Array(values.length);
    const denominator = Math.max(1, values.length - 1);
    const span = maximum - minimum;
    for (let index = 0; index < values.length; index += 1) {
      const time = times[index];
      positions[index] = validCount >= 2 && span > 0 && time != null
        ? area.left + area.width * (time - minimum) / span
        : area.left + area.width * index / denominator;
    }
    xPositionCache.set(values, { cacheKey, positions });
    return positions;
  };

  function dateAxisModel(dates, area) {
    const values = Array.isArray(dates) ? dates : [];
    const cacheKey = `${currentMode}:${Math.round(area.width)}`;
    const cached = dateAxisCache.get(values);
    if (cached?.cacheKey === cacheKey) return cached.model;

    const firstTs = values.length ? dateTimestamp(values[0]) : null;
    const lastTs = values.length ? dateTimestamp(values.at(-1)) : null;
    const spanDays = firstTs != null && lastTs != null ? Math.abs(lastTs - firstTs) / 86400000 : 0;
    const estimatedLabelWidth = currentMode === 'monthly' || spanDays > 120 ? 54 : 42;
    const desired = Math.max(2, Math.min(values.length, Math.floor(area.width / (estimatedLabelWidth + 14))));
    const indices = [];
    let previous = -1;
    for (let index = 0; index < desired; index += 1) {
      const value = Math.round((values.length - 1) * index / Math.max(1, desired - 1));
      if (value !== previous) indices.push(value);
      previous = value;
    }
    const labels = indices.map((index) => {
      const value = values[index];
      const text = String(value || '');
      if (currentMode === 'monthly' || spanDays > 730) return text.slice(0, 7).replace('-', '/');
      if (spanDays > 120) return shortDate(value, true).slice(2);
      return shortDate(value, spanDays > 300);
    });
    const model = { indices, labels };
    dateAxisCache.set(values, { cacheKey, model });
    return model;
  }

  drawDateAxis = function drawDateAxisCached(ctx, dates, xPositions, width, height, area) {
    if (!dates.length) return;
    const { indices, labels } = dateAxisModel(dates, area);
    ctx.font = '10.5px system-ui';
    ctx.fillStyle = '#aaa3b5';
    ctx.textBaseline = 'top';
    let lastRight = -Infinity;
    for (let position = 0; position < indices.length; position += 1) {
      const index = indices[position];
      const text = labels[position];
      const measured = ctx.measureText(text).width;
      const x = Math.max(area.left, Math.min(width - area.right - measured, xPositions[index] - measured / 2));
      const isLast = position === indices.length - 1;
      if (x > lastRight + 7 || isLast) {
        ctx.fillText(text, x, height - area.bottom + 11);
        lastRight = x + measured;
      }
    }
  };

  displayCell = function displayCellWithSharedFormatters(key, row, mode) {
    if (mode === 'ranking') {
      const special = rankingCellValue(key, row);
      if (special != null) return special;
    }
    if (mode === 'tracks') {
      if (key === 'play_date') return formatDate(row[key]);
      if (key === 'first_played_at' || key === 'last_played_at') {
        return row._daily_total ? '—' : formatDate(row[key], true);
      }
      if (key === 'play_count') {
        const value = finiteNumber(row[key]);
        return value == null ? '—' : `${numberFormatter.format(value)}回`;
      }
      if (key === 'daily_share') {
        const value = finiteNumber(row[key]);
        return value == null ? '—' : `${numberFormatter.format(value)}%`;
      }
    }
    const value = row[key];
    if (key.includes('date') || key.includes('jst') || key === 'period_key') {
      return formatDate(value, key.includes('jst'));
    }
    if (typeof value === 'number') return numberFormatter.format(value);
    return value == null || value === '' ? '—' : String(value);
  };

  updateSummary = function updateSummarySinglePass(rows, mode) {
    const values = Array.isArray(rows) ? rows : [];
    const rankingHosts = mode === 'ranking' ? new Set() : null;
    const rankingWeeks = mode === 'ranking' ? new Set() : null;
    const trackDays = mode === 'tracks' ? new Set() : null;
    const trackKeys = mode === 'tracks' ? new Set() : null;
    let rankingBest = null;
    let listenerMax = null;
    let listenerMin = null;
    let listenerAverageTotal = 0;
    let listenerAverageCount = 0;
    let streamTotal = 0;
    let streamCount = 0;
    let memberTotal = 0;
    let memberCount = 0;
    let weightedListenerTotal = 0;
    let weightedListenerCount = 0;
    let durationTotal = 0;
    let durationCount = 0;
    let trackPlayTotal = 0;
    let trackPlayMax = 0;

    for (const row of values) {
      if (mode === 'ranking') {
        const rank = finiteNumber(row.rank);
        if (rank != null) rankingBest = rankingBest == null ? rank : Math.min(rankingBest, rank);
        if (row.host_name) rankingHosts.add(row.host_name);
        if (row.ranking_date) rankingWeeks.add(row.ranking_date);
        continue;
      }
      if (mode === 'tracks') {
        if (row.period_complete === false || row.play_count_excluded === true) continue;
        if (row.play_date) trackDays.add(row.play_date);
        if (row.track_key) trackKeys.add(row.track_key);
        const playCount = finiteNumber(row.play_count) || 0;
        trackPlayTotal += playCount;
        trackPlayMax = Math.max(trackPlayMax, playCount);
        continue;
      }

      const maximum = finiteNumber(row.listener_max ?? row.listener_count);
      if (maximum != null) listenerMax = listenerMax == null ? maximum : Math.max(listenerMax, maximum);

      if (mode === 'daily' || mode === 'weekly' || mode === 'monthly') {
        const listenerAverage = finiteNumber(row.listener_avg);
        const streamGrowth = finiteNumber(row.stream_growth);
        const memberGrowth = finiteNumber(row.member_growth);
        if (listenerAverage != null) { listenerAverageTotal += listenerAverage; listenerAverageCount += 1; }
        if (streamGrowth != null) { streamTotal += streamGrowth; streamCount += 1; }
        if (memberGrowth != null) { memberTotal += memberGrowth; memberCount += 1; }
        continue;
      }

      if (mode === 'broadcasts') {
        const minimum = finiteNumber(row.listener_min);
        if (minimum != null) listenerMin = listenerMin == null ? minimum : Math.min(listenerMin, minimum);
        const average = finiteNumber(row.listener_avg);
        if (average != null) {
          const samples = finiteNumber(row.sample_count);
          const weight = samples != null && samples > 0 ? samples : 1;
          weightedListenerTotal += average * weight;
          weightedListenerCount += weight;
        }
        const start = finiteNumber(row.started_at);
        const end = finiteNumber(row.ended_at);
        if (start != null && end != null && end >= start) {
          durationTotal += end - start;
          durationCount += 1;
        }
      }
    }

    if (mode === 'ranking') {
      setText('#periodLabel', '期間数');
      setText('#maxLabel', '最高順位');
      setText('#streamLabel', '掲載ホスト');
      setText('#memberLabel', '掲載週');
      setText('#periods', numberText(values.length));
      setText('#maxListener', rankingBest == null ? '—' : `${numberFormatter.format(rankingBest)}位`);
      setText('#streamGrowth', numberText(rankingHosts.size));
      setText('#memberGrowth', numberText(rankingWeeks.size));
      return;
    }

    if (mode === 'tracks') {
      setText('#periodLabel', '有効日数');
      setText('#maxLabel', '総再生回数');
      setText('#streamLabel', '曲数');
      setText('#memberLabel', '1曲の最多');
      setText('#periods', numberText(trackDays.size));
      setText('#maxListener', trackDays.size ? numberText(trackPlayTotal) : '—');
      setText('#streamGrowth', trackDays.size ? numberText(trackKeys.size) : '—');
      setText('#memberGrowth', trackPlayMax ? `${numberText(trackPlayMax)}回` : '—');
      return;
    }

    if (mode === 'broadcasts') {
      const averageDuration = durationCount ? durationTotal / durationCount : null;
      const totalMinutes = averageDuration == null ? null : Math.round(averageDuration / 60000);
      const durationText = totalMinutes == null ? '—'
        : totalMinutes < 60 ? `${totalMinutes}分`
          : totalMinutes % 60 ? `${Math.floor(totalMinutes / 60)}時間${totalMinutes % 60}分`
            : `${Math.floor(totalMinutes / 60)}時間`;
      setText('#periodLabel', '最小同接');
      setText('#maxLabel', '最大同接');
      setText('#streamLabel', '平均同接');
      setText('#memberLabel', '平均放送時間');
      setText('#periods', numberText(listenerMin));
      setText('#maxListener', numberText(listenerMax));
      setText('#streamGrowth', weightedListenerCount ? numberText(weightedListenerTotal / weightedListenerCount) : '—');
      setText('#memberGrowth', durationText);
      return;
    }

    if (mode === 'daily' || mode === 'weekly' || mode === 'monthly') {
      const periodName = { daily: '日平均', weekly: '週平均', monthly: '月平均' }[mode];
      setText('#periodLabel', '期間数');
      setText('#maxLabel', `平均同接（${periodName}）`);
      setText('#streamLabel', `再生数増加（${periodName}）`);
      setText('#memberLabel', `メンバー増加（${periodName}）`);
      setText('#periods', numberText(values.length));
      setText('#maxListener', listenerAverageCount ? numberText(listenerAverageTotal / listenerAverageCount) : '—');
      setText('#streamGrowth', streamCount ? numberText(streamTotal / streamCount) : '—');
      setText('#memberGrowth', memberCount ? numberText(memberTotal / memberCount) : '—');
      return;
    }

    setText('#periodLabel', mode === 'raw' ? '表示件数' : '期間数');
    setText('#maxLabel', '最大同接');
    setText('#streamLabel', '再生数増加');
    setText('#memberLabel', 'メンバー増加');
    setText('#periods', numberText(values.length));
    setText('#maxListener', numberText(listenerMax));
    setText('#streamGrowth', '—');
    setText('#memberGrowth', '—');
  };

  window.fetch = function fetchWithHistoryCache(input, init = {}) {
    const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (!rawUrl) return nativeFetch(input, init);

    let url;
    try {
      url = new URL(rawUrl, window.location.href);
    } catch {
      return nativeFetch(input, init);
    }
    if (url.origin !== window.location.origin || !cacheablePaths.has(url.pathname)) {
      return nativeFetch(input, init);
    }

    if (url.pathname === '/api/track-history' && url.searchParams.get('latest') !== '1') {
      url.searchParams.set('v', '14');
    } else if (url.pathname === '/api/history') {
      url.searchParams.set('v', '15');
    }
    const options = { ...init };
    if (options.cache === 'no-store') delete options.cache;
    return nativeFetch(url.toString(), options);
  };
})();
