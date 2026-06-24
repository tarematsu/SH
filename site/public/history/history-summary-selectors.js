(() => {
  const SUMMARY_MODES = new Set(['daily', 'weekly', 'monthly']);
  const baseSetMode = setMode;
  const baseLoad = load;
  const notice = $('#notice');

  MODE_HELP.daily = ['日次集計', '日ごとの最大同接、再生数増加、メンバー増加を表示します。'];
  MODE_HELP.ranking = ['リーダーボード', 'Stationheadで放送しているホストの週次順位です。掲載がない週は「圏外」として表示します。'];

  function normalizeNotice() {
    if (!SUMMARY_MODES.has(currentMode)) return;
    const original = notice.textContent;
    const count = original.match(/^([\d,.]+期間を表示)/)?.[1];
    if (!count) return;
    const latest = original.match(/最終\s+([^）)]+)[）)]/)?.[1];
    const next = latest ? `${count} : 最新 ${latest}` : count;
    if (next !== original) notice.textContent = next;
  }

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
      $('#tableTitle').textContent = 'リーダーボード';
    }
  }

  setMode = function setModeWithoutSummaryDateMenus(mode) {
    baseSetMode(mode);
    applyModeUi(mode);
  };

  load = async function loadWithConciseNotice(options = {}) {
    const result = await baseLoad(options);
    if (SUMMARY_MODES.has(currentMode) && !options.append) normalizeNotice();
    if (currentMode === 'ranking') {
      notice.textContent = notice.textContent.replaceAll('週間リーダーボード', 'リーダーボード');
    }
    return result;
  };

  new MutationObserver(() => {
    if (SUMMARY_MODES.has(currentMode) && !/読み込み中/.test(notice.textContent)) {
      normalizeNotice();
    } else if (currentMode === 'ranking') {
      const next = notice.textContent.replaceAll('週間リーダーボード', 'リーダーボード');
      if (next !== notice.textContent) notice.textContent = next;
    }
  }).observe(notice, { childList: true, characterData: true, subtree: true });

  applyModeUi(currentMode);
})();