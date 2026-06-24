(() => {
  const descriptions = {
    monthly: ['月次集計', '月ごとの最大同接、再生数増加、メンバー増加を表示します。'],
    tracks: ['再生曲', '選択した日または月曜日始まりの週の再生曲を表示します。'],
    broadcasts: ['公式ステへ', '同接推移を重ねて表示します。'],
    ranking: ['リーダーボード', 'Stationheadで放送している櫻坂ホストの週次順位です。'],
  };

  Object.entries(descriptions).forEach(([mode, value]) => {
    MODE_HELP[mode] = value;
  });

  const applyDescription = () => {
    const value = descriptions[currentMode];
    const guide = $('#guide');
    if (!value || !guide) return;
    const html = `<strong>${value[0]}</strong><span>${value[1]}</span>`;
    if (guide.innerHTML !== html) guide.innerHTML = html;
  };

  const formatDuration = (milliseconds) => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
    const totalMinutes = Math.round(milliseconds / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (!hours) return `${minutes}分`;
    return minutes ? `${hours}時間${minutes}分` : `${hours}時間`;
  };

  const averageOf = (rows, key) => {
    const values = rows.map((row) => finiteNumber(row[key])).filter((value) => value != null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };

  const originalUpdateSummary = updateSummary;
  updateSummary = function updateSummaryWithAverages(rows, mode) {
    originalUpdateSummary(rows, mode);

    const averagePeriod = {
      daily: '日平均',
      weekly: '週平均',
      monthly: '月平均',
    }[mode];

    if (averagePeriod) {
      const streamAverage = averageOf(rows, 'stream_growth');
      const memberAverage = averageOf(rows, 'member_growth');
      $('#streamLabel').textContent = `再生数増加（${averagePeriod}）`;
      $('#memberLabel').textContent = `メンバー増加（${averagePeriod}）`;
      $('#streamGrowth').textContent = streamAverage == null ? '—' : fmt(streamAverage);
      $('#memberGrowth').textContent = memberAverage == null ? '—' : fmt(memberAverage);
      return;
    }

    if (mode !== 'broadcasts') return;

    $('#periodLabel').textContent = '放送数';
    $('#maxLabel').textContent = '最大同接';
    $('#streamLabel').textContent = '平均同接';
    $('#memberLabel').textContent = '平均放送時間';

    const weighted = rows.reduce((result, row) => {
      const average = finiteNumber(row.listener_avg);
      const count = finiteNumber(row.sample_count);
      if (average == null) return result;
      const weight = count != null && count > 0 ? count : 1;
      result.total += average * weight;
      result.weight += weight;
      return result;
    }, { total: 0, weight: 0 });

    const durations = rows.map((row) => {
      const start = finiteNumber(row.started_at);
      const end = finiteNumber(row.ended_at);
      return start != null && end != null && end >= start ? end - start : null;
    }).filter((value) => value != null);

    $('#streamGrowth').textContent = weighted.weight ? fmt(weighted.total / weighted.weight) : '—';
    $('#memberGrowth').textContent = durations.length
      ? formatDuration(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : '—';
  };

  const clearChartPresentation = () => {
    $('#chartLegend')?.replaceChildren();
    const detail = $('#chartDetail');
    if (detail) detail.innerHTML = '<span>グラフをタッチまたはクリックすると、その時点の詳細を表示します。</span>';
    const canvas = $('#chart');
    const context = canvas?.getContext('2d');
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
    chartState = null;
    selectedChartIndex = null;
  };

  const originalSetMode = setMode;
  setMode = function stableSetMode(mode) {
    clearChartPresentation();
    originalSetMode(mode);
    applyDescription();
  };

  const guide = $('#guide');
  if (guide) {
    new MutationObserver(() => {
      if (currentMode === 'broadcasts') applyDescription();
    }).observe(guide, { childList: true, subtree: true, characterData: true });
  }

  const originalLoad = load;
  let requestedLoad = 0;
  let loadQueue = Promise.resolve();
  const waitForIdle = async () => {
    while (loading) await new Promise((resolve) => setTimeout(resolve, 24));
  };

  load = function stableLoad(options = {}) {
    const requestId = ++requestedLoad;
    const append = Boolean(options.append);
    const run = async () => {
      await waitForIdle();
      if (!append && requestId !== requestedLoad) return;
      return originalLoad(options);
    };
    loadQueue = loadQueue.then(run, run);
    return loadQueue;
  };

  const likesScript = document.createElement('script');
  likesScript.src = '/history/history-track-likes.js';
  document.head.appendChild(likesScript);
})();
