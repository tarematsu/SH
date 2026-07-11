(() => {
  const cacheKey = (key) => String(key || '')
    .replace(/^track-history:v(?:11|12|13|14|15|16):/, 'track-history:v17:');

  if (typeof readCache === 'function' && typeof writeCache === 'function') {
    const previousReadCache = readCache;
    const previousWriteCache = writeCache;
    readCache = (key) => previousReadCache(cacheKey(key));
    writeCache = (key, value) => previousWriteCache(cacheKey(key), value);
  }

  const previousFetch = window.fetch.bind(window);
  window.fetch = function fetchWithTrackRecoveryVersion(input, init = {}) {
    const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (!rawUrl) return previousFetch(input, init);
    try {
      const url = new URL(rawUrl, window.location.href);
      if (url.origin === window.location.origin
          && url.pathname === '/api/track-history'
          && url.searchParams.get('latest') !== '1') {
        url.searchParams.set('recovery', '5');
        return previousFetch(url.toString(), init);
      }
    } catch {}
    return previousFetch(input, init);
  };
})();
