(() => {
  if (typeof renderNowDisplay === 'function') {
    const baseRenderNowDisplay = renderNowDisplay;
    renderNowDisplay = function patchedRenderNowDisplay(track, progressMs = 0) {
      baseRenderNowDisplay(track, progressMs);
      if (!track) return;
      const copy = document.querySelector('#nowPlaying .track-copy');
      if (!copy) return;
      const count = Number(track.bite_count);
      if (!Number.isFinite(count)) return;
      const node = document.createElement('p');
      node.className = 'now-playing-bites';
      node.textContent = `♡${count.toLocaleString('ja-JP')}`;
      const artist = copy.querySelector('p');
      const anchor = artist || copy.querySelector('h3');
      anchor?.insertAdjacentElement('afterend', node);
    };
  }

  const modeTabs = document.querySelectorAll('.mode-tabs button');
  if (!modeTabs.length || typeof load !== 'function' || typeof setMode !== 'function') return;

  let pendingReload = null;
  const clearChartPresentation = () => {
    document.querySelector('#chartLegend')?.replaceChildren();
    const detail = document.querySelector('#chartDetail');
    if (detail) detail.innerHTML = '<span>グラフをタッチまたはクリックすると、その時点の詳細を表示します。</span>';
    const canvas = document.querySelector('#chart');
    const context = canvas?.getContext('2d');
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
  };
  const loadWhenReady = () => {
    clearTimeout(pendingReload);
    const run = () => {
      if (loading) {
        pendingReload = setTimeout(run, 50);
        return;
      }
      nextCursor = null;
      load();
    };
    run();
  };

  const baseSetMode = setMode;
  setMode = function patchedSetMode(mode) {
    clearChartPresentation();
    baseSetMode(mode);
  };

  modeTabs.forEach((button) => {
    button.onclick = () => {
      setMode(button.dataset.mode);
      loadWhenReady();
    };
  });
  document.querySelectorAll('.range-presets button').forEach((button) => {
    button.onclick = () => {
      applyPreset(button.dataset.days);
      clearChartPresentation();
      loadWhenReady();
    };
  });
  const loadButton = document.querySelector('#load');
  if (loadButton) loadButton.onclick = () => {
    clearChartPresentation();
    loadWhenReady();
  };
})();
