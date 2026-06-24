(() => {
  const SUMMARY_MODES = new Set(['daily', 'weekly', 'monthly']);
  const baseSetMode = setMode;
  const baseLoad = load;
  const menu = $('#summaryPeriodMenu');
  const currentLabel = $('#summaryPeriodCurrent');
  const list = $('#summaryPeriodList');
  const notice = $('#notice');

  MODE_HELP.daily = ['日次集計', '日ごとの最大同接、再生数増加、メンバー増加を表示します。'];
  MODE_HELP.ranking = ['リーダーボード', 'Stationheadで放送しているホストの週次順位です。掲載がない週は「圏外」として表示します。'];

  function displayPeriod(value, mode = currentMode) {
    const text = String(value || '');
    if (mode === 'monthly') return text.slice(0, 7).replace('-', '/');
    return text.slice(0, 10).replaceAll('-', '/');
  }

  function periodValues() {
    return [...new Set(current.map((row) => row?.period_key).filter(Boolean))]
      .sort((a, b) => (dateTimestamp(b) ?? 0) - (dateTimestamp(a) ?? 0));
  }

  function focusPeriod(period) {
    const sorted = [...current].sort((a, b) => (dateTimestamp(rowDate(a)) ?? 0) - (dateTimestamp(rowDate(b)) ?? 0));
    const sampled = sampleRows(sorted);
    const target = dateTimestamp(period);
    let bestIndex = -1;
    let bestDistance = Infinity;
    sampled.forEach((row, index) => {
      const stamp = dateTimestamp(rowDate(row));
      if (stamp == null || target == null) return;
      const distance = Math.abs(stamp - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    if (bestIndex < 0) return;
    selectedChartIndex = bestIndex;
    currentLabel.textContent = displayPeriod(period);
    list.querySelectorAll('button').forEach((button) => {
      button.classList.toggle('active', button.dataset.period === period);
    });
    draw(current, '', bestIndex);
  }

  function buildMenu() {
    if (!SUMMARY_MODES.has(currentMode)) return;
    const periods = periodValues();
    list.innerHTML = periods.map((period) =>
      `<button type="button" data-period="${escapeHtml(period)}">${escapeHtml(displayPeriod(period))}</button>`
    ).join('');
    list.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        focusPeriod(button.dataset.period);
        menu.open = false;
      });
    });
    if (periods.length) {
      currentLabel.textContent = displayPeriod(periods[0]);
      list.querySelector('button')?.classList.add('active');
    } else {
      currentLabel.textContent = currentMode === 'monthly' ? '月データなし' : currentMode === 'weekly' ? '週データなし' : '日データなし';
    }
  }

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
    menu.hidden = !summary;
    if (summary) {
      $('#fromWrap').hidden = true;
      $('#toWrap').hidden = true;
      $('#load').hidden = true;
    }
    if (mode === 'ranking') {
      $('#guide strong').textContent = 'リーダーボード';
      $('#tableTitle').textContent = 'リーダーボード';
    }
  }

  setMode = function setModeWithSummaryMenus(mode) {
    baseSetMode(mode);
    applyModeUi(mode);
  };

  load = async function loadWithSummaryMenus(options = {}) {
    const result = await baseLoad(options);
    if (SUMMARY_MODES.has(currentMode) && !options.append) {
      buildMenu();
      normalizeNotice();
    }
    if (currentMode === 'ranking') {
      notice.textContent = notice.textContent.replaceAll('週間リーダーボード', 'リーダーボード');
    }
    return result;
  };

  new MutationObserver(() => {
    if (SUMMARY_MODES.has(currentMode) && !/読み込み中/.test(notice.textContent)) {
      buildMenu();
      normalizeNotice();
    } else if (currentMode === 'ranking') {
      const next = notice.textContent.replaceAll('週間リーダーボード', 'リーダーボード');
      if (next !== notice.textContent) notice.textContent = next;
    }
  }).observe(notice, { childList: true, characterData: true, subtree: true });

  applyModeUi(currentMode);
  if (SUMMARY_MODES.has(currentMode) && current.length) buildMenu();
})();