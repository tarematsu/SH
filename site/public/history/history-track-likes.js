(() => {
  const baseVisibleKeys = visibleKeys;
  const baseLabelsFor = labelsFor;
  const baseDisplayCell = displayCell;
  const likeFormatter = new Intl.NumberFormat('ja-JP');
  const numberFormatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
  const rankingPalette = ['#f6c7d9', '#9c7bf4', '#7ee787', '#ffb86b', '#7ad7ff'];
  let rankingModelSource = null;
  let rankingModel = null;

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
      setTextIfChanged('#periodLabel', '期間数');
      setTextIfChanged('#maxLabel', '最高順位');
      setTextIfChanged('#streamLabel', '掲載ホスト');
      setTextIfChanged('#memberLabel', '掲載週');
      setTextIfChanged('#periods', numberText(values.length));
      setTextIfChanged('#maxListener', rankingBest == null ? '—' : `${numberFormatter.format(rankingBest)}位`);
      setTextIfChanged('#streamGrowth', numberText(rankingHosts.size));
      setTextIfChanged('#memberGrowth', numberText(rankingWeeks.size));
      return;
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

  function buildRankingModel(values) {
    const hostNames = new Map();
    const byHost = new Map();
    const weekSet = new Set();
    let maxRank = 10;

    for (const row of values) {
      const rank = rankNumber(row);
      if (rank != null) maxRank = Math.max(maxRank, rank);
      const host = String(row.host_name || row.host_alias || '').trim();
      const week = String(row.ranking_date || '');
      if (week) weekSet.add(week);
      if (!host || !week) continue;
      const hostKey = host.toLowerCase();
      if (!hostNames.has(hostKey)) hostNames.set(hostKey, host);
      let weeks = byHost.get(hostKey);
      if (!weeks) {
        weeks = new Map();
        byHost.set(hostKey, weeks);
      }
      weeks.set(week, row);
    }

    const hosts = [...hostNames.entries()].sort(([aKey, a], [bKey, b]) => {
      const ai = FEATURED_HOSTS.indexOf(aKey);
      const bi = FEATURED_HOSTS.indexOf(bKey);
      if (ai >= 0 || bi >= 0) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      return a.localeCompare(b);
    });
    const weeks = [...weekSet].sort();
    const series = new Array(hosts.length);
    for (let hostIndex = 0; hostIndex < hosts.length; hostIndex += 1) {
      const [hostKey, host] = hosts[hostIndex];
      const rowsByWeek = byHost.get(hostKey) || new Map();
      const hostRows = new Array(weeks.length);
      const ranks = new Array(weeks.length);
      for (let index = 0; index < weeks.length; index += 1) {
        const row = rowsByWeek.get(weeks[index]) || null;
        hostRows[index] = row;
        ranks[index] = row ? rankNumber(row) : null;
      }
      series[hostIndex] = {
        host,
        values: hostRows,
        ranks,
        color: rankingPalette[hostIndex % rankingPalette.length],
      };
    }
    return {
      weeks,
      series,
      maxRank,
      ticks: [...new Set([
        1,
        Math.ceil(maxRank / 4),
        Math.ceil(maxRank / 2),
        Math.ceil(maxRank * 3 / 4),
        maxRank,
      ])].sort((a, b) => a - b),
    };
  }

  function rankingModelFor(values) {
    if (rankingModelSource === values && rankingModel) return { model: rankingModel, rebuilt: false };
    rankingModelSource = values;
    rankingModel = buildRankingModel(values);
    return { model: rankingModel, rebuilt: true };
  }

  drawRanking = function drawRankingCachedModel(rows, selected = null) {
    const values = Array.isArray(rows) ? rows : [];
    const { model, rebuilt } = rankingModelFor(values);
    const { weeks, series, maxRank, ticks } = model;
    const { ctx, width, height } = prepareCanvas();
    if (!weeks.length || !series.length) {
      drawEmpty(ctx, width, height, 'ランキングデータがありません');
      return;
    }

    const area = { left: 58, right: 18, top: 18, bottom: 42 };
    area.width = Math.max(1, width - area.left - area.right);
    area.height = Math.max(1, height - area.top - area.bottom);
    drawGrid(ctx, width, height, area);
    const xPositions = makeXPositions(weeks, area);
    const yFor = (rank) => area.top + (Math.max(1, rank) - 1) / Math.max(1, maxRank - 1) * area.height;
    ctx.font = '10.5px system-ui';
    ctx.fillStyle = '#aaa3b5';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const rank of ticks) ctx.fillText(`${rank}位`, area.left - 8, yFor(rank));
    drawDateAxis(ctx, weeks, xPositions, width, height, area);

    for (const item of series) {
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let open = false;
      for (let index = 0; index < item.ranks.length; index += 1) {
        const rank = item.ranks[index];
        if (rank == null) {
          open = false;
          continue;
        }
        const x = xPositions[index];
        const y = yFor(rank);
        if (!open) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        open = true;
      }
      ctx.stroke();
      ctx.fillStyle = item.color;
      for (let index = 0; index < item.ranks.length; index += 1) {
        const rank = item.ranks[index];
        if (rank == null) continue;
        ctx.beginPath();
        ctx.arc(xPositions[index], yFor(rank), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const selectedWeekIndex = Number.isInteger(selected) ? selected : null;
    if (selectedWeekIndex != null && weeks[selectedWeekIndex]) drawSelection(ctx, xPositions[selectedWeekIndex], area);
    chartState = { type: 'ranking', weeks, xPositions, series, selectedIndex: selectedWeekIndex };
    if (rebuilt) setChartRange(weeks);
    if (selectedWeekIndex != null) renderRankingDetail(selectedWeekIndex);
  };
})();
