(() => {
  const VERSION = '2026-06-25-artist-backfill-v1';
  const KEY = `track-metadata-refresh:${VERSION}`;
  if (localStorage.getItem(KEY)) return;

  async function run() {
    let totalUpdated = 0;
    let completed = false;

    for (let batch = 0; batch < 20; batch += 1) {
      const response = await fetch('/api/track-metadata-refresh', {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);

      totalUpdated += Number(data.updated || 0);
      if (data.done) {
        completed = true;
        break;
      }
      if (!data.processed || !data.updated) break;
    }

    localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), completed, totalUpdated }));

    if (totalUpdated > 0) {
      for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = sessionStorage.key(index);
        if (key?.startsWith('track-history:')) sessionStorage.removeItem(key);
      }
      if (typeof currentMode !== 'undefined' && currentMode === 'tracks' && typeof load === 'function') {
        load();
      }
    }
  }

  run().catch((error) => {
    console.error('track metadata bulk refresh failed', error);
  });
})();
