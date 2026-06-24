(() => {
  const descriptions = {
    monthly: ['月次集計', '月ごとの最大同接、再生数増加、メンバー増加を表示します。'],
    tracks: ['再生曲', '選択した日または月曜日始まりの週の再生曲を表示します。'],
    broadcasts: ['公式ステヘ', '全放送の開始時刻を0分として重ねて表示します。'],
    ranking: ['リーダーボード', 'Stationheadで放送しているホストの週次順位です。'],
  };

  Object.entries(descriptions).forEach(([mode, value]) => {
    MODE_HELP[mode] = value;
  });

  function apply() {
    const value = descriptions[currentMode];
    if (!value) return;
    const guide = $('#guide');
    const expected = `<strong>${value[0]}</strong><span>${value[1]}</span>`;
    if (guide && guide.innerHTML !== expected) guide.innerHTML = expected;
    if (currentMode === 'tracks' && $('#tableTitle')?.textContent !== '再生曲') {
      $('#tableTitle').textContent = '再生曲';
    }
  }

  function clearLegend() {
    const legend = $('#chartLegend');
    if (legend) legend.replaceChildren();
  }

  let pendingReload = null;
  function loadAfterCurrentRequest() {
    clearTimeout(pendingReload);
    const run = () => {
      if (loading) {
        pendingReload = setTimeout(run, 50);
        return;
      }
      nextCursor = null;
      load();
    };
    run();
  }

  const baseSetMode = setMode;
  setMode = function setModeWithFinalCopy(mode) {
    clearLegend();
    baseSetMode(mode);
    apply();
  };

  new MutationObserver(apply).observe($('#guide'), {
    childList: true,
    characterData: true,
    subtree: true,
  });

  document.querySelectorAll('.mode-tabs button').forEach((button) => {
    button.onclick = () => {
      setMode(button.dataset.mode);
      loadAfterCurrentRequest();
    };
  });

  document.querySelectorAll('.range-presets button').forEach((button) => {
    button.onclick = () => {
      applyPreset(button.dataset.days);
      clearLegend();
      loadAfterCurrentRequest();
    };
  });

  const loadButton = $('#load');
  if (loadButton) loadButton.onclick = () => {
    clearLegend();
    loadAfterCurrentRequest();
  };

  const likesScript = document.createElement('script');
  likesScript.src = '/history/history-track-likes.js';
  document.head.appendChild(likesScript);

  apply();
})();
