(() => {
  const descriptions = {
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

  const baseSetMode = setMode;
  setMode = function setModeWithFinalCopy(mode) {
    baseSetMode(mode);
    apply();
  };

  new MutationObserver(apply).observe($('#guide'), {
    childList: true,
    characterData: true,
    subtree: true,
  });

  document.querySelectorAll('.mode-tabs button').forEach((button) => {
    button.addEventListener('click', () => setTimeout(apply, 0));
  });

  apply();
})();