(() => {
  const TRACK_LABELS = {
    play_date: '日付',
    title: '曲名',
    artist: 'アーティスト',
    play_count: '再生回数',
    daily_share: 'その日の割合',
    first_played_at: '最初の再生',
    last_played_at: '最後の再生',
  };

  MODE_HELP.tracks = ['再生曲', '選択した日または月曜日始まりの週の再生曲を表示します。'];

  const baseSetMode = setMode;
  const baseVisibleKeys = visibleKeys;
  const baseLabelsFor = labelsFor;
  const baseDisplayCell = displayCell;
  const baseUpdateSummary = updateSummary;
  const baseDraw = draw;

  setMode = function (mode) {
    baseSetMode(mode);
    if (mode !== 'tracks') return;
    $('#metric').hidden = true;
    $('#metric').disabled = true;
    $('#chartPanel').hidden = true;
    $('#tableTitle').textContent = '再生曲';
    $('#rankingWeeklyPanel').hidden = true;
  };

  visibleKeys = (mode) => mode === 'tracks' ? Object.keys(TRACK_LABELS) : baseVisibleKeys(mode);

  labelsFor = (mode) => mode === 'tracks' ? TRACK_LABELS : baseLabelsFor(mode);

  displayCell = function (key, row, mode) {
    if (mode !== 'tracks') return baseDisplayCell(key, row, mode);
    if (key === 'play_date') return formatDate(row[key]);
    if (key === 'first_played_at' || key === 'last_played_at') {
      return row._daily_total ? '—' : formatDate(row[key], true);
    }
    if (key === 'play_count') return `${fmt(row[key])}回`;
    if (key === 'daily_share') {
      const value = finiteNumber(row[key]);
      return value == null ? '—' : `${value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}%`;
    }
    const value = row[key];
    return value == null || value === '' ? '—' : String(value);
  };

  updateSummary = function (rows, mode) {
    if (mode !== 'tracks') return baseUpdateSummary(rows, mode);
    const days = new Set(rows.map((r) => r.play_date).filter(Boolean));
    const tracks = new Set(rows.map((r) => r.track_key).filter(Boolean));
    const total = rows.reduce((s, r) => s + (finiteNumber(r.play_count) || 0), 0);
    const max = rows.reduce((m, r) => Math.max(m, finiteNumber(r.play_count) || 0), 0);
    $('#periodLabel').textContent = '日数';
    $('#maxLabel').textContent = '総再生回数';
    $('#streamLabel').textContent = '曲数';
    $('#memberLabel').textContent = '1曲の最多';
    $('#periods').textContent = fmt(days.size);
    $('#maxListener').textContent = fmt(total);
    $('#streamGrowth').textContent = fmt(tracks.size);
    $('#memberGrowth').textContent = max ? `${fmt(max)}回` : '—';
  };

  draw = function (rows, metric, selected) {
    if (currentMode === 'tracks') {
      $('#chartPanel').hidden = true;
      return;
    }
    return baseDraw(rows, metric, selected);
  };
})();
