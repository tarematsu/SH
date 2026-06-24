(() => {
  const descriptions = {
    monthly: ['月次集計', '月ごとの最大同接、再生数増加、メンバー増加を表示します。'],
    tracks: ['再生曲', '選択した日または月曜日始まりの週の再生曲を表示します。'],
    broadcasts: ['公式ステヘ', '同接推移を重ねて表示します。'],
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
