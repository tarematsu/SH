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

  function numberText(value) {
    const number = finiteNumber(value);
    return number == null ? '—' : numberFormatter.format(number);
  }

  function setText(selector, value) {
    const node = $(selector);
    const text = String(value ?? '');
    if (node && node.textContent !== text) node.textContent = text;
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
      if (key === 'play_count') return `${numberText(row[key])}回`;
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
      setText('#periodLabel', '日数');
      setText('#maxLabel', '総再生回数');
      setText('#streamLabel', '曲数');
      setText('#memberLabel', '1曲の最多');
      setText('#periods', numberText(trackDays.size));
      setText('#maxListener', numberText(trackPlayTotal));
      setText('#streamGrowth', numberText(trackKeys.size));
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
      url.searchParams.set('v', '12');
    } else if (url.pathname === '/api/history') {
      url.searchParams.set('v', '12');
    }
    const options = { ...init };
    if (options.cache === 'no-store') delete options.cache;
    return nativeFetch(url.toString(), options);
  };
})();
