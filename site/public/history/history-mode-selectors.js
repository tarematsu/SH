(() => {
  const baseSetMode = setMode;
  const baseLoad = load;
  let resolvingLatestTrackDate = false;

  const rangePresets = $('#rangePresets');
  const fromWrap = $('#fromWrap');
  const toWrap = $('#toWrap');
  const trackDateWrap = $('#trackDateWrap');
  const trackDate = $('#trackDate');
  const rankingScopeTabs = $('#rankingScopeTabs');
  const loadButton = $('#load');
  const todayUtc = () => new Date().toISOString().slice(0, 10);

  function setStandardControlsVisible(visible) {
    rangePresets.hidden = !visible;
    fromWrap.hidden = !visible;
    toWrap.hidden = !visible;
  }

  async function resolveLatestTrackDate() {
    if (trackDate.value || resolvingLatestTrackDate) return trackDate.value;
    resolvingLatestTrackDate = true;
    try {
      const response = await fetch('/api/track-history?latest=1', { cache: 'no-store' });
      const data = await response.json();
      trackDate.value = data?.latest_date || todayUtc();
      return trackDate.value;
    } finally {
      resolvingLatestTrackDate = false;
    }
  }

  function selectedRankingScope() {
    return rankingScopeTabs.querySelector('button.active')?.dataset.scope || 'featured';
  }

  function syncRankingScope(scope) {
    rankingScopeTabs.querySelectorAll('button').forEach((button) => button.classList.toggle('active', button.dataset.scope === scope));
    $('#rankingScope').value = scope;
    $('#host').value = '';
  }

  shouldShowRankingChart = () => true;

  setMode = function setModeWithDedicatedSelectors(mode) {
    baseSetMode(mode);
    const tracks = mode === 'tracks';
    const ranking = mode === 'ranking';
    const broadcasts = mode === 'broadcasts';
    const dedicated = tracks || ranking || broadcasts;
    setStandardControlsVisible(!dedicated);
    trackDateWrap.hidden = !tracks;
    rankingScopeTabs.hidden = !ranking;
    loadButton.hidden = dedicated;
    $('#rankingScopeWrap').hidden = true;
    $('#hostWrap').hidden = true;
    if (ranking) syncRankingScope(selectedRankingScope());
  };

  load = async function loadWithDedicatedSelectors(options = {}) {
    if (currentMode === 'tracks') {
      const selected = trackDate.value || await resolveLatestTrackDate();
      $('#from').value = selected;
      $('#to').value = selected;
    } else if (currentMode === 'ranking') {
      $('#from').value = '2024-05-01';
      $('#to').value = todayUtc();
      syncRankingScope(selectedRankingScope());
    } else if (currentMode === 'broadcasts') {
      $('#from').value = '2024-05-01';
      $('#to').value = todayUtc();
    }
    return baseLoad(options);
  };

  trackDate.addEventListener('change', () => { nextCursor = null; load(); });
  rankingScopeTabs.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => {
      syncRankingScope(button.dataset.scope);
      nextCursor = null;
      load();
    });
  });
})();
