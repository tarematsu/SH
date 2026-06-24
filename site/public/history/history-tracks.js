(() => {
  const TRACK_LABELS = {
    play_date: '日付',
    title: '曲名',
    artist: 'アーティスト',
    play_count: '再生回数',
    first_played_at: '最初の再生',
    last_played_at: '最後の再生',
  };

  MODE_HELP.tracks = [
    '日別再生曲',
    'キューの開始時刻と各曲の長さから、1日ごとの曲別再生回数を表示します。',
  ];

  const baseSetMode = setMode;
  const baseVisibleKeys = visibleKeys;
  const baseLabelsFor = labelsFor;
  const baseDisplayCell = displayCell;
  const baseUpdateSummary = updateSummary;
  const baseDraw = draw;
  const baseLoad = load;

  setMode = function setModeWithTracks(mode) {
    baseSetMode(mode);
    if (mode !== 'tracks') return;
    $('#metric').hidden = true;
    $('#metric').disabled = true;
    $('#chartPanel').hidden = true;
    $('#tableTitle').textContent = '日別・曲別の再生回数';
    $('#rankingWeeklyPanel').hidden = true;
  };

  visibleKeys = function visibleKeysWithTracks(mode) {
    return mode === 'tracks' ? Object.keys(TRACK_LABELS) : baseVisibleKeys(mode);
  };

  labelsFor = function labelsForTracks(mode) {
    return mode === 'tracks' ? TRACK_LABELS : baseLabelsFor(mode);
  };

  displayCell = function displayTrackCell(key, row, mode) {
    if (mode !== 'tracks') return baseDisplayCell(key, row, mode);
    if (key === 'play_date') return formatDate(row[key]);
    if (key === 'first_played_at' || key === 'last_played_at') return formatDate(row[key], true);
    if (key === 'play_count') return `${fmt(row[key])}回`;
    const value = row[key];
    return value == null || value === '' ? '—' : String(value);
  };

  updateSummary = function updateTrackSummary(rows, mode) {
    if (mode !== 'tracks') return baseUpdateSummary(rows, mode);
    const days = new Set(rows.map((row) => row.play_date).filter(Boolean));
    const tracks = new Set(rows.map((row) => row.track_key).filter(Boolean));
    const totalPlays = rows.reduce((sum, row) => sum + (finiteNumber(row.play_count) || 0), 0);
    const maxPlays = rows.reduce((max, row) => Math.max(max, finiteNumber(row.play_count) || 0), 0);
    $('#periodLabel').textContent = '日数';
    $('#maxLabel').textContent = '総再生回数';
    $('#streamLabel').textContent = '曲数';
    $('#memberLabel').textContent = '1曲の最多';
    $('#periods').textContent = fmt(days.size);
    $('#maxListener').textContent = fmt(totalPlays);
    $('#streamGrowth').textContent = fmt(tracks.size);
    $('#memberGrowth').textContent = maxPlays ? `${fmt(maxPlays)}回` : '—';
  };

  draw = function drawWithoutTrackChart(rows, metric, selected) {
    if (currentMode === 'tracks') {
      $('#chartPanel').hidden = true;
      return;
    }
    return baseDraw(rows, metric, selected);
  };

  load = async function loadTrackHistory(options = {}) {
    if (currentMode !== 'tracks') return baseLoad(options);
    if (loading) return;

    loading = true;
    selectedChartIndex = null;
    nextCursor = null;
    const from = $('#from').value;
    const to = $('#to').value;
    $('#notice').textContent = '読み込み中…';

    try {
      const params = new URLSearchParams({ from, to, limit: '10000', v: '1' });
      const response = await fetch(`/api/track-history?${params}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);

      current = data.rows || [];
      updateSummary(current, 'tracks');
      renderTable(current, 'tracks', false);
      $('#more').hidden = true;
      $('#chartPanel').hidden = true;
      $('#rankingWeeklyPanel').hidden = true;

      if (data.setup_required) {
        $('#notice').textContent = '再生曲データの保存テーブルがまだありません。';
      } else {
        const suffix = data.truncated ? '（表示上限10,000行）' : '';
        $('#notice').textContent = `${fmt(current.length)}件の日別・曲別集計を表示${suffix}`;
      }
    } catch (error) {
      $('#notice').textContent = `API error: ${error.message}`;
    } finally {
      loading = false;
    }
  };
})();
