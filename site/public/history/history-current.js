(() => {
  const RANKING_MODE = 'ranking';
  const RANKING_LABELS = {
    ranking_date: '週',
    host_name: 'ホスト',
    rank: '順位',
    previous_rank: '前週順位',
    rank_change: '前週比',
    ranking_type: 'ランキング種別',
    source_sheet: '順位データ出典',
    quality_score: '品質',
  };
  MODE_HELP[RANKING_MODE] = [
    '週間リーダーボード',
    'Stationheadで放送しているホストの週次順位です。掲載がない週は「圏外」として表示します。',
  ];

  const rankingButton = document.querySelector('[data-mode="ranking"]') || document.createElement('button');
  if (!rankingButton.isConnected) {
    rankingButton.type = 'button';
    rankingButton.dataset.mode = RANKING_MODE;
    rankingButton.textContent = 'リーダーボード';
    document.querySelector('.mode-tabs')?.appendChild(rankingButton);
  }

  const rankingControls = document.createElement('div');
  rankingControls.id = 'rankingControls';
  rankingControls.hidden = true;
  rankingControls.innerHTML = '<label>表示対象<select id="rankingScope"><option value="featured">櫻坂</option><option value="all">全ホスト</option></select></label><label>ホスト検索<input id="rankingHost" type="search" maxlength="100"></label>';
  $('#historyControls')?.appendChild(rankingControls);

  const rankingWeeklyPanel = document.createElement('section');
  rankingWeeklyPanel.className = 'panel';
  rankingWeeklyPanel.hidden = true;
  rankingWeeklyPanel.innerHTML = '<div class="head"><div><p class="section-kicker">BUDDIES WEEKLY METRICS</p><h2>Buddies週間実績（参考）</h2></div></div><div class="table"><table><thead id="rankingWeeklyThead"></thead><tbody id="rankingWeeklyTbody"></tbody></table></div>';
  document.querySelector('.panel:last-of-type')?.after(rankingWeeklyPanel);

  const rankingBaseSetMode = setMode;
  const rankingBaseLoad = load;
  const rankingBaseVisibleKeys = visibleKeys;
  const rankingBaseLabelsFor = labelsFor;
  const rankingBaseDisplayCell = displayCell;
  const rankingBaseUpdateSummary = updateSummary;
  let rankingController = null;
  let rankingRequestToken = 0;

  function rankingCell(key, row) {
    if (key === 'rank') return row.is_out_of_rank || row.rank == null ? '圏外' : `${fmt(row.rank)}位`;
    if (key === 'previous_rank') return row.previous_out_of_rank || row.previous_rank == null
      ? (row.previous_out_of_rank ? '圏外' : '—') : `${fmt(row.previous_rank)}位`;
    if (key === 'rank_change') {
      const change = finiteNumber(row.rank_change);
      return change == null ? '—' : change > 0 ? `↑${fmt(change)}` : change < 0 ? `↓${fmt(Math.abs(change))}` : '—';
    }
    return null;
  }

  setMode = function setRankingMode(mode) {
    rankingBaseSetMode(mode);
    const ranking = mode === RANKING_MODE;
    if (!ranking) {
      rankingController?.abort();
      rankingRequestToken += 1;
    }
    rankingControls.hidden = !ranking;
    rankingWeeklyPanel.hidden = !ranking;
    if (!ranking) return;
    $('#metric').hidden = true;
    $('#metric').disabled = true;
    $('#chartPanel').hidden = true;
    $('#tableTitle').textContent = '週間リーダーボード';
    $('#more').hidden = true;
  };

  visibleKeys = (mode) => mode === RANKING_MODE ? Object.keys(RANKING_LABELS) : rankingBaseVisibleKeys(mode);
  labelsFor = (mode) => mode === RANKING_MODE ? RANKING_LABELS : rankingBaseLabelsFor(mode);
  displayCell = function displayRankingCell(key, row, mode) {
    if (mode === RANKING_MODE) {
      const special = rankingCell(key, row);
      if (special != null) return special;
      if (key === 'ranking_date') return formatDate(row[key]);
      if (typeof row[key] === 'number') return fmt(row[key]);
      return row[key] == null || row[key] === '' ? '—' : String(row[key]);
    }
    return rankingBaseDisplayCell(key, row, mode);
  };

  updateSummary = function updateRankingSummary(rows, mode) {
    if (mode !== RANKING_MODE) return rankingBaseUpdateSummary(rows, mode);
    const ranks = rows.map((row) => finiteNumber(row.rank)).filter((value) => value != null);
    $('#periodLabel').textContent = '表示行数';
    $('#maxLabel').textContent = '最高順位';
    $('#streamLabel').textContent = '掲載ホスト';
    $('#memberLabel').textContent = '掲載週';
    $('#periods').textContent = fmt(rows.length);
    $('#maxListener').textContent = ranks.length ? `${fmt(Math.min(...ranks))}位` : '—';
    $('#streamGrowth').textContent = fmt(new Set(rows.map((row) => row.host_name).filter(Boolean)).size);
    $('#memberGrowth').textContent = fmt(new Set(rows.map((row) => row.ranking_date).filter(Boolean)).size);
  };

  function renderRankingWeekly(rows) {
    const keys = ['ranking_date', 'stream_growth', 'member_growth', 'listener_avg', 'listener_min', 'listener_max'];
    const labels = { ranking_date: '週', stream_growth: '週間再生数', member_growth: '週間メンバー増加', listener_avg: '平均同接', listener_min: '最小同接', listener_max: '最大同接' };
    $('#rankingWeeklyThead').innerHTML = `<tr>${keys.map((key) => `<th>${escapeHtml(labels[key])}</th>`).join('')}</tr>`;
    $('#rankingWeeklyTbody').innerHTML = rows.map((row) => `<tr>${keys.map((key) => `<td>${escapeHtml(key === 'ranking_date' ? formatDate(row[key]) : fmt(row[key]))}</td>`).join('')}</tr>`).join('');
  }

  load = async function loadRankingOrHistory(options = {}) {
    if (currentMode !== RANKING_MODE) return rankingBaseLoad(options);
    const token = ++rankingRequestToken;
    rankingController?.abort();
    rankingController = new AbortController();
    $('#notice').hidden = false;
    $('#notice').textContent = 'リーダーボードを読み込み中…';
    const params = new URLSearchParams({
      mode: RANKING_MODE,
      from: $('#from').value,
      to: $('#to').value,
      scope: $('#rankingScope').value,
      v: '1',
      limit: '5000',
    });
    const host = $('#rankingHost').value.trim();
    if (host) params.set('host', host);
    try {
      const response = await fetch(`/api/history?${params}`, { signal: rankingController.signal, cache: 'no-store', headers: { accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `API ${response.status}`);
      if (token !== rankingRequestToken || currentMode !== RANKING_MODE) return;
      current = Array.isArray(data.rows) ? data.rows : [];
      nextCursor = null;
      updateSummary(current, RANKING_MODE);
      renderTable(current, RANKING_MODE, false);
      renderRankingWeekly(data.weekly_metrics || []);
      $('#chartPanel').hidden = true;
      $('#more').hidden = true;
      const scope = host ? `「${host}」を検索` : $('#rankingScope').value === 'featured' ? '櫻坂を表示' : '全ホストを表示';
      $('#notice').textContent = `${scope}：${fmt(current.length)}行（圏外週を含む）${data.truncated ? '（最大5000件）' : ''}`;
    } catch (error) {
      if (error?.name !== 'AbortError' && token === rankingRequestToken) $('#notice').textContent = `API error: ${error.message}`;
    } finally {
      if (token === rankingRequestToken) rankingController = null;
    }
  };

  rankingButton.onclick = () => {
    nextCursor = null;
    setMode(RANKING_MODE);
    load();
  };
  $('#rankingScope').onchange = () => { nextCursor = null; load(); };
  $('#rankingHost').onkeydown = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); nextCursor = null; load(); }
  };

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
