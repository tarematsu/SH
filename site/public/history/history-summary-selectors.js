(() => {
  const SUMMARY_MODES = new Set(['daily', 'weekly', 'monthly']);
  const baseSetMode = setMode;

  MODE_HELP.daily = ['日次集計', '日ごとの最大同接、再生数増加、メンバー増加を表示します。'];
  MODE_HELP.ranking = ['リーダーボード', 'Stationheadで放送しているホストの週次順位です。'];

  function applyModeUi(mode) {
    const summary = SUMMARY_MODES.has(mode);
    if (summary) {
      $('#rangePresets').hidden = false;
      $('#fromWrap').hidden = true;
      $('#toWrap').hidden = true;
      $('#load').hidden = true;
    }
    if (mode === 'ranking') {
      $('#guide strong').textContent = 'リーダーボード';
      $('#guide span').textContent = 'Stationheadで放送しているホストの週次順位です。';
      $('#tableTitle').textContent = 'リーダーボード';
    }
  }

  setMode = function setModeWithoutSummaryDateMenus(mode) {
    baseSetMode(mode);
    applyModeUi(mode);
  };

  applyModeUi(currentMode);
})();