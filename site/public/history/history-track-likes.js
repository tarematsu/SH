(() => {
  const baseVisibleKeys = visibleKeys;
  const baseLabelsFor = labelsFor;
  const baseDisplayCell = displayCell;
  const likeFormatter = new Intl.NumberFormat('ja-JP');
  const numberFormatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });

  visibleKeys = (mode) => mode === 'tracks'
    ? [...baseVisibleKeys(mode), 'like_count']
    : baseVisibleKeys(mode);

  labelsFor = (mode) => mode === 'tracks'
    ? { ...baseLabelsFor(mode), like_count: 'いいね数' }
    : baseLabelsFor(mode);

  displayCell = function displayTrackLikeCell(key, row, mode) {
    if (mode === 'tracks' && key === 'like_count') {
      if (row?._daily_total) return '—';
      const value = Number(row?.like_count);
      return Number.isFinite(value) ? `${likeFormatter.format(value)}件` : '—';
    }
    return baseDisplayCell(key, row, mode);
  };

  function numberText(value) {
    const number = finiteNumber(value);
    return number == null ? '—' : numberFormatter.format(number);
  }

  function setTextIfChanged(selector, value) {
    const node = $(selector);
    const text = String(value ?? '');
    if (node && node.textContent !== text) node.textContent = text;
  }

  updateSummary = function updateSummaryRuntimeSinglePass(rows, mode) {
    const values = Array.isArray(rows) ? rows : [];
    const trackDays = mode === 'tracks' ? new Set() : null;
    const trackKeys = mode === 'tracks' ? new Set() : null;
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

    if (mode === 'tracks') {
      setTextIfChanged('#periodLabel', '有効日数');
      setTextIfChanged('#maxLabel', '総再生回数');
      setTextIfChanged('#streamLabel', '曲数');
      setTextIfChanged('#memberLabel', '1曲の最多');
      setTextIfChanged('#periods', numberText(trackDays.size));
      setTextIfChanged('#maxListener', trackDays.size ? numberText(trackPlayTotal) : '—');
      setTextIfChanged('#streamGrowth', trackDays.size ? numberText(trackKeys.size) : '—');
      setTextIfChanged('#memberGrowth', trackPlayMax ? `${numberText(trackPlayMax)}回` : '—');
      return;
    }

    if (mode === 'broadcasts') {
      const averageDuration = durationCount ? durationTotal / durationCount : null;
      const totalMinutes = averageDuration == null ? null : Math.round(averageDuration / 60000);
      const durationText = totalMinutes == null ? '—'
        : totalMinutes < 60 ? `${totalMinutes}分`
          : totalMinutes % 60 ? `${Math.floor(totalMinutes / 60)}時間${totalMinutes % 60}分`
            : `${Math.floor(totalMinutes / 60)}時間`;
      setTextIfChanged('#periodLabel', '最小同接');
      setTextIfChanged('#maxLabel', '最大同接');
      setTextIfChanged('#streamLabel', '平均同接');
      setTextIfChanged('#memberLabel', '平均放送時間');
      setTextIfChanged('#periods', numberText(listenerMin));
      setTextIfChanged('#maxListener', numberText(listenerMax));
      setTextIfChanged('#streamGrowth', weightedListenerCount ? numberText(weightedListenerTotal / weightedListenerCount) : '—');
      setTextIfChanged('#memberGrowth', durationText);
      return;
    }

    if (mode === 'daily' || mode === 'weekly' || mode === 'monthly') {
      const periodName = { daily: '日平均', weekly: '週平均', monthly: '月平均' }[mode];
      setTextIfChanged('#periodLabel', '期間数');
      setTextIfChanged('#maxLabel', `平均同接（${periodName}）`);
      setTextIfChanged('#streamLabel', `再生数増加（${periodName}）`);
      setTextIfChanged('#memberLabel', `メンバー増加（${periodName}）`);
      setTextIfChanged('#periods', numberText(values.length));
      setTextIfChanged('#maxListener', listenerAverageCount ? numberText(listenerAverageTotal / listenerAverageCount) : '—');
      setTextIfChanged('#streamGrowth', streamCount ? numberText(streamTotal / streamCount) : '—');
      setTextIfChanged('#memberGrowth', memberCount ? numberText(memberTotal / memberCount) : '—');
      return;
    }

    setTextIfChanged('#periodLabel', mode === 'raw' ? '表示件数' : '期間数');
    setTextIfChanged('#maxLabel', '最大同接');
    setTextIfChanged('#streamLabel', '再生数増加');
    setTextIfChanged('#memberLabel', 'メンバー増加');
    setTextIfChanged('#periods', numberText(values.length));
    setTextIfChanged('#maxListener', numberText(listenerMax));
    setTextIfChanged('#streamGrowth', '—');
    setTextIfChanged('#memberGrowth', '—');
  };
})();
