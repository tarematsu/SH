(() => {
  const descriptions = {
    monthly: ['月次集計', '月ごとの平均同接、再生数増加、メンバー増加を表示します。'],
    tracks: ['再生曲', 'UTC日付（日本時間9:00〜翌8:59）または月曜日始まりの週で再生曲を表示します。'],
    broadcasts: ['公式ステへ', '同接推移を重ねて表示します。'],
    ranking: ['リーダーボード', 'Stationheadで放送している櫻坂ホストの週次順位です。'],
  };
  Object.entries(descriptions).forEach(([mode, value]) => { MODE_HELP[mode] = value; });

  const todayUtc = () => new Date().toISOString().slice(0, 10);
  const averageOf = (rows, key) => {
    const values = rows.map((row) => finiteNumber(row[key])).filter((value) => value != null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const minimumOf = (rows, key) => rows.reduce((minimum, row) => {
    const value = finiteNumber(row[key]);
    if (value == null) return minimum;
    return minimum == null ? value : Math.min(minimum, value);
  }, null);
  const formatDuration = (milliseconds) => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
    const totalMinutes = Math.round(milliseconds / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (!hours) return `${minutes}分`;
    return minutes ? `${hours}時間${minutes}分` : `${hours}時間`;
  };
  const mondayOf = (value) => {
    const date = new Date(`${value || todayUtc()}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString().slice(0, 10);
  };
  const sundayOf = (value) => {
    const date = new Date(`${mondayOf(value)}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 6);
    return date.toISOString().slice(0, 10);
  };
  const originalUpdateSummary = updateSummary;

  updateSummary = function updateSummaryWithAverages(rows, mode) {
    originalUpdateSummary(rows, mode);
    const periodName = { daily: '日平均', weekly: '週平均', monthly: '月平均' }[mode];
    if (periodName) {
      const listenerAverage = averageOf(rows, 'listener_avg');
      const streamAverage = averageOf(rows, 'stream_growth');
      const memberAverage = averageOf(rows, 'member_growth');
      $('#maxLabel').textContent = `平均同接（${periodName}）`;
      $('#streamLabel').textContent = `再生数増加（${periodName}）`;
      $('#memberLabel').textContent = `メンバー増加（${periodName}）`;
      $('#maxListener').textContent = listenerAverage == null ? '—' : fmt(listenerAverage);
      $('#streamGrowth').textContent = streamAverage == null ? '—' : fmt(streamAverage);
      $('#memberGrowth').textContent = memberAverage == null ? '—' : fmt(memberAverage);
      return;
    }
    if (mode !== 'broadcasts') return;
    $('#periodLabel').textContent = '最小同接';
    $('#maxLabel').textContent = '最大同接';
    $('#streamLabel').textContent = '平均同接';
    $('#memberLabel').textContent = '平均放送時間';
    const listenerMinimum = minimumOf(rows, 'listener_min');
    $('#periods').textContent = listenerMinimum == null ? '—' : fmt(listenerMinimum);
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

  const applyDescription = () => {
    const value = descriptions[currentMode];
    const guide = $('#guide');
    if (!value || !guide) return;
    const html = `<strong>${value[0]}</strong><span>${value[1]}</span>`;
    if (guide.innerHTML !== html) guide.innerHTML = html;
  };

  let loadVersion = 0;
  let activeController = null;
  const isCurrent = (version, mode) => version === loadVersion && currentMode === mode;

  const prepareRange = async (mode, signal, version) => {
    if (mode === 'tracks') {
      const input = $('#trackDate');
      if (!input.value) {
        const response = await fetch('/api/track-history?latest=1', { signal, headers: { accept: 'application/json' } });
        const data = await response.json();
        if (!isCurrent(version, mode)) return false;
        input.value = data?.latest_date || todayUtc();
      }
      if ($('#trackWeekMode').checked) {
        $('#from').value = mondayOf(input.value);
        $('#to').value = sundayOf(input.value);
      } else {
        $('#from').value = input.value;
        $('#to').value = input.value;
      }
    } else if (mode === 'ranking' || mode === 'broadcasts') {
      $('#from').value = '2024-05-01';
      $('#to').value = todayJst();
      if (mode === 'ranking') {
        $('#rankingScope').value = 'featured';
        $('#host').value = '';
      }
    }
    return true;
  };

  const renderTrackData = (data, from, to) => {
    current = data.rows || [];
    nextCursor = null;
    updateSummary(current, 'tracks');
    const tableRows = withDailyTotals(current);
    renderTable(tableRows, 'tracks', false);
    $('#tbody').querySelectorAll('tr').forEach((row, index) => {
      if (tableRows[index]?._daily_total) row.classList.add('daily-total-row');
    });
    $('#more').hidden = true;
    $('#chartPanel').hidden = true;
    $('#rankingWeeklyPanel').hidden = true;
    const timezone = data.timezone || 'UTC';
    $('#notice').textContent = data.setup_required
      ? '再生曲データの保存テーブルがまだありません。'
      : `${formatDate(from)}〜${formatDate(to)}：${fmt(current.length)}件を表示（${timezone} / 日本時間9:00〜翌8:59）${data.truncated ? '（表示上限）' : ''}`;
  };

  const renderHistoryData = (data, mode, append, scope, host) => {
    if (append) current.push(...(data.rows || []));
    else current = data.rows || [];
    nextCursor = data.next_cursor || null;
    updateSummary(current, mode);
    renderTable(data.rows || [], mode, append);
    $('#more').hidden = mode !== 'raw' || !data.has_more;
    if (mode === 'ranking') {
      renderWeeklyMetrics(data.weekly_metrics || []);
      $('#rankingWeeklyPanel').hidden = false;
      $('#chartPanel').hidden = false;
      drawRanking(current);
    } else {
      $('#rankingWeeklyPanel').hidden = true;
      $('#chartPanel').hidden = mode === 'raw';
      if (mode !== 'raw' && mode !== 'broadcasts') draw(current, $('#metric').value);
    }
    $('#chartDetail').innerHTML = '<span>グラフをタッチまたはクリックすると、その時点の詳細を表示します。</span>';
    if (mode === 'ranking' && data.setup_required) {
      $('#notice').textContent = '週間リーダーボードのデータがまだありません。ランキングSQLを投入してください。';
    } else if (mode === 'ranking') {
      $('#notice').textContent = `櫻坂を表示：${fmt(current.length)}行（圏外週を含む）${data.truncated ? '（最大5000件）' : ''}`;
    } else if (mode === 'broadcasts' && data.setup_required) {
      $('#notice').textContent = '公式ステヘのD1データが未登録です。';
    } else if (mode === 'broadcasts') {
      $('#notice').textContent = `${fmt(current.length)}件の公式ステヘを表示`;
    } else if (mode === 'raw') {
      $('#notice').textContent = `${fmt(current.length)}件を表示中（200件ずつ取得）`;
    } else {
      const count = `${fmt(current.length)}期間を表示`;
      const latest = data.latest_live_observed_at ? formatDate(data.latest_live_observed_at, true) : null;
      $('#notice').textContent = latest ? `${count} : 最新 ${latest}` : count;
    }
  };

  load = async function stableLoad({ append = false } = {}) {
    const mode = currentMode;
    const version = ++loadVersion;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    loading = true;
    selectedChartIndex = null;
    $('#notice').textContent = append ? '続きを読み込み中…' : '読み込み中…';
    $('#chartPanel')?.setAttribute('aria-busy', 'true');

    try {
      const prepared = await prepareRange(mode, controller.signal, version);
      if (!prepared || !isCurrent(version, mode)) return;
      const from = $('#from').value;
      const to = $('#to').value;

      if (mode === 'tracks') {
        const key = `track-history:v11:${from}:${to}`;
        let data = readCache(key);
        if (!data) {
          const tbody = $('#tbody');
          if (tbody) {
            tbody.replaceChildren();
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = Math.max(1, $('#thead')?.querySelectorAll('th').length || 1);
            cell.textContent = '再生曲を読み込み中…';
            row.appendChild(cell);
            tbody.appendChild(row);
          }
          const params = new URLSearchParams({ from, to, limit: '2000', likes: '1', v: '11' });
          const response = await fetch(`/api/track-history?${params}`, {
            signal: controller.signal,
            headers: { accept: 'application/json' },
          });
          data = await response.json();
          if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
          writeCache(key, data);
        }
        if (!isCurrent(version, mode)) return;
        renderTrackData(data, from, to);
        return;
      }

      const scope = mode === 'ranking' ? $('#rankingScope').value : '';
      const host = mode === 'ranking' ? $('#host').value.trim() : '';
      const key = cacheKey(mode, from, to, `${scope}:${host}`);
      let data = !append && mode !== 'raw' ? readCache(key) : null;
      if (!data) {
        const params = new URLSearchParams({ mode, from, to, v: '10' });
        if (mode === 'raw') {
          params.set('limit', '200');
          if (append && nextCursor) params.set('cursor', nextCursor);
        }
        if (mode === 'ranking') {
          params.set('limit', '5000');
          params.set('scope', scope);
          if (host) params.set('host', host);
        }
        const response = await fetch(`/api/history?${params}`, { signal: controller.signal, cache: 'no-store' });
        data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || `API ${response.status}`);
        if (!append && mode !== 'raw') writeCache(key, data);
      }
      if (!isCurrent(version, mode)) return;
      renderHistoryData(data, mode, append, scope, host);
    } catch (error) {
      if (error?.name !== 'AbortError' && isCurrent(version, mode)) $('#notice').textContent = `API error: ${error.message}`;
    } finally {
      if (version === loadVersion) {
        loading = false;
        activeController = null;
        $('#chartPanel')?.removeAttribute('aria-busy');
      }
    }
  };

  const originalSetMode = setMode;
  setMode = function stableSetMode(mode) {
    loadVersion += 1;
    activeController?.abort();
    activeController = null;
    loading = false;
    chartState = null;
    selectedChartIndex = null;
    $('#chartLegend')?.replaceChildren();
    originalSetMode(mode);
    applyDescription();
  };

  const guide = $('#guide');
  if (guide) {
    new MutationObserver(() => {
      if (currentMode === 'broadcasts') applyDescription();
    }).observe(guide, { childList: true, subtree: true, characterData: true });
  }

  const likesScript = document.createElement('script');
  likesScript.src = '/history/history-track-likes.js';
  document.head.appendChild(likesScript);

  load();
})();
