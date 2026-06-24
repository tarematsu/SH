(() => {
  const baseSetMode = setMode;
  const baseLoad = load;
  let resolvingLatestTrackDate = false;

  const rangePresets = $('#rangePresets');
  const fromWrap = $('#fromWrap');
  const toWrap = $('#toWrap');
  const trackDateWrap = $('#trackDateWrap');
  const rankingWeekWrap = $('#rankingWeekWrap');
  const trackDate = $('#trackDate');
  const rankingWeek = $('#rankingWeek');
  const loadButton = $('#load');

  function isoWeekValue(date = new Date()) {
    const local = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = local.getUTCDay() || 7;
    local.setUTCDate(local.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(local.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((local - yearStart) / 86400000) + 1) / 7);
    return `${local.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  function weekRange(value) {
    const match = /^(\d{4})-W(\d{2})$/.exec(value || '');
    if (!match) return null;
    const year = Number(match[1]);
    const week = Number(match[2]);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const monday = new Date(jan4);
    monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (week - 1) * 7);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return {
      from: monday.toISOString().slice(0, 10),
      to: sunday.toISOString().slice(0, 10),
    };
  }

  function setStandardControlsVisible(visible) {
    rangePresets.hidden = !visible;
    fromWrap.hidden = !visible;
    toWrap.hidden = !visible;
  }

  async function resolveLatestTrackDate() {
    if (trackDate.value || resolvingLatestTrackDate) return trackDate.value;
    resolvingLatestTrackDate = true;
    try {
      for (const days of [30, 365, 3650]) {
        const to = todayJst();
        const fromDate = new Date(`${to}T00:00:00+09:00`);
        fromDate.setDate(fromDate.getDate() - days);
        const from = new Intl.DateTimeFormat('sv-SE', {
          timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(fromDate);
        const params = new URLSearchParams({ from, to, limit: '10000', v: '3' });
        const response = await fetch(`/api/track-history?${params}`, { cache: 'no-store' });
        const data = await response.json();
        const latest = data?.rows?.map((row) => row.play_date).filter(Boolean).sort().at(-1);
        if (latest) {
          trackDate.value = latest;
          return latest;
        }
      }
      trackDate.value = todayJst();
      return trackDate.value;
    } finally {
      resolvingLatestTrackDate = false;
    }
  }

  setMode = function setModeWithDedicatedSelectors(mode) {
    baseSetMode(mode);
    const tracks = mode === 'tracks';
    const ranking = mode === 'ranking';
    const dedicated = tracks || ranking;
    setStandardControlsVisible(!dedicated);
    trackDateWrap.hidden = !tracks;
    rankingWeekWrap.hidden = !ranking;
    loadButton.hidden = dedicated;
    $('#rankingScopeWrap').hidden = true;
    $('#hostWrap').hidden = true;
    $('#rankingScope').value = 'all';
    $('#host').value = '';
    if (ranking && !rankingWeek.value) rankingWeek.value = isoWeekValue();
  };

  load = async function loadWithDedicatedSelectors(options = {}) {
    if (currentMode === 'tracks') {
      const selected = trackDate.value || await resolveLatestTrackDate();
      $('#from').value = selected;
      $('#to').value = selected;
    } else if (currentMode === 'ranking') {
      const range = weekRange(rankingWeek.value || isoWeekValue());
      if (range) {
        $('#from').value = range.from;
        $('#to').value = range.to;
      }
      $('#rankingScope').value = 'all';
      $('#host').value = '';
    }
    return baseLoad(options);
  };

  trackDate.addEventListener('change', () => {
    nextCursor = null;
    load();
  });
  rankingWeek.addEventListener('change', () => {
    nextCursor = null;
    load();
  });
})();
