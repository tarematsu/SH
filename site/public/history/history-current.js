(() => {
  const baseSetMode = setMode;
  const baseLoad = load;
  const baseVisibleKeys = visibleKeys;
  const baseLabelsFor = labelsFor;
  const baseDisplayCell = displayCell;
  const baseUpdateSummary = updateSummary;
  const CURRENT_MODE = 'current';
  const CURRENT_LABELS = {
    observed_jst: '\u89b3\u6e2c\u6642\u523b',
    source: '\u53d6\u5f97\u5143',
    listener_count: '\u73fe\u5728\u30ea\u30b9\u30ca\u30fc',
    online_member_count: '\u30aa\u30f3\u30e9\u30a4\u30f3\u30e1\u30f3\u30d0\u30fc',
    total_member_count: '\u7dcf\u30e1\u30f3\u30d0\u30fc',
    total_stream_count: '\u7dcf\u518d\u751f\u6570',
    track_title: '\u66f2\u540d',
    artist_name: '\u30a2\u30fc\u30c6\u30a3\u30b9\u30c8',
    host_handle: '\u30db\u30b9\u30c8',
    comment_count: '\u30b3\u30e1\u30f3\u30c8',
    quality_score: '\u54c1\u8cea',
  };
  MODE_HELP.current = [
    '\u73fe\u5728\u306e\u30c7\u30fc\u30bf',
    '\u30df\u30cb\u30c3\u30c8\u30d5\u30a1\u30af\u30c8\u306e\u76f4\u8fd1\u0031\u0034\u0034\u0030\u4ef6\u3092\u8868\u793a\u3057\u307e\u3059\u3002',
  ];
  let requestToken = 0;
  let controller = null;

  const isCurrentMode = () => currentMode === CURRENT_MODE;

  function currentGuide() {
    const guide = $('#guide');
    if (guide && isCurrentMode()) {
      guide.innerHTML = `<strong>${MODE_HELP.current[0]}</strong><span>${MODE_HELP.current[1]}</span>`;
    }
  }

  function normalizeRows(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      ...row,
      observed_jst: row.observed_at,
    }));
  }

  setMode = function setCurrentMode(mode) {
    requestToken += 1;
    controller?.abort();
    controller = null;
    baseSetMode(mode);
    if (mode !== CURRENT_MODE) return;
    $('#historyControls').hidden = true;
    $('#metric').hidden = true;
    $('#metric').disabled = true;
    $('#chartPanel').hidden = false;
    $('#chartTitle').textContent = '\u73fe\u5728\u30ea\u30b9\u30ca\u30fc\u63a8\u79fb';
    $('#chartFoot').textContent = '\u76f4\u8fd1\u0031\u0034\u0034\u0030\u5206\u306e minute_facts \u3092\u6642\u7cfb\u5217\u3067\u8868\u793a\u3057\u307e\u3059\u3002';
    $('#tableTitle').textContent = '\u76f4\u8fd1\u0031\u0034\u0034\u0030\u4ef6';
    $('#more').hidden = true;
    currentGuide();
  };

  visibleKeys = (mode) => mode === CURRENT_MODE ? Object.keys(CURRENT_LABELS) : baseVisibleKeys(mode);
  labelsFor = (mode) => mode === CURRENT_MODE ? CURRENT_LABELS : baseLabelsFor(mode);

  displayCell = function displayCurrentCell(key, row, mode) {
    if (mode !== CURRENT_MODE) return baseDisplayCell(key, row, mode);
    if (key === 'observed_jst') return formatDate(row[key], true);
    if (typeof row[key] === 'number') return fmt(row[key]);
    return row[key] == null || row[key] === '' ? '-' : String(row[key]);
  };

  updateSummary = function updateCurrentSummary(rows, mode) {
    if (mode !== CURRENT_MODE) return baseUpdateSummary(rows, mode);
    const latest = rows.at(-1) || {};
    $('#periodLabel').textContent = '\u8868\u793a\u4ef6\u6570';
    $('#maxLabel').textContent = '\u6700\u65b0\u30ea\u30b9\u30ca\u30fc';
    $('#streamLabel').textContent = '\u6700\u65b0\u7dcf\u518d\u751f\u6570';
    $('#memberLabel').textContent = '\u6700\u65b0\u30e1\u30f3\u30d0\u30fc';
    $('#periods').textContent = fmt(rows.length);
    $('#maxListener').textContent = fmt(latest.listener_count);
    $('#streamGrowth').textContent = fmt(latest.total_stream_count);
    $('#memberGrowth').textContent = fmt(latest.total_member_count);
  };

  async function loadCurrent() {
    const token = ++requestToken;
    controller?.abort();
    controller = new AbortController();
    $('#notice').hidden = false;
    $('#notice').textContent = '\u73fe\u5728\u30c7\u30fc\u30bf\u3092\u8aad\u307f\u8fbc\u307f\u4e2d\u2026';
    try {
      const response = await fetch('/api/history-current?latest=1&v=1', {
        signal: controller.signal,
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `API ${response.status}`);
      if (token !== requestToken || !isCurrentMode()) return;
      current = normalizeRows(data.rows);
      nextCursor = null;
      updateSummary(current, CURRENT_MODE);
      renderTable([...current].reverse(), CURRENT_MODE, false);
      $('#more').hidden = true;
      $('#chartPanel').hidden = false;
      draw(current, 'listener_count');
      const latest = data.latest_live || data.latest_any;
      const freshness = latest?.observed_at ? formatDate(latest.observed_at, true) : '-';
      $('#notice').textContent = `${fmt(current.length)}\u4ef6\u3092\u8868\u793a\u4e2d \u00b7 \u6700\u65b0: ${freshness}`;
      $('#chartDetail').innerHTML = '<span>グラフをタッチまたはクリックすると、その時点の詳細を表示します。</span>';
      currentGuide();
    } catch (error) {
      if (error?.name === 'AbortError') return;
      if (token === requestToken && isCurrentMode()) {
        $('#notice').textContent = `API error: ${error.message}`;
        $('#guide').innerHTML = `<strong>\u73fe\u5728\u30c7\u30fc\u30bf\u3092\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093</strong><span>${escapeHtml(error.message)}</span>`;
      }
    } finally {
      if (token === requestToken) controller = null;
    }
  }

  load = function loadCurrentOrHistory(options = {}) {
    return isCurrentMode() ? loadCurrent() : baseLoad(options);
  };

})();
