(() => {
  const baseVisibleKeys = visibleKeys;
  const baseLabelsFor = labelsFor;
  const baseDisplayCell = displayCell;

  visibleKeys = (mode) => mode === 'tracks'
    ? [...baseVisibleKeys(mode), 'like_count']
    : baseVisibleKeys(mode);

  labelsFor = (mode) => mode === 'tracks'
    ? { ...baseLabelsFor(mode), like_count: 'いいね数' }
    : baseLabelsFor(mode);

  displayCell = function displayTrackLikeCell(key, row, mode) {
    if (mode === 'tracks' && key === 'like_count') {
      if (row?._daily_total) return '—';
      const value = Number(row?.like_count);
      return Number.isFinite(value) ? `${value.toLocaleString('ja-JP')}件` : '—';
    }
    return baseDisplayCell(key, row, mode);
  };
})();
