(() => {
  const nativeFetch = window.fetch.bind(window);
  const cacheablePaths = new Set(['/api/track-history', '/api/history', '/api/broadcast-series']);

  window.fetch = function fetchWithHistoryCache(input, init = {}) {
    const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (!rawUrl) return nativeFetch(input, init);

    let url;
    try {
      url = new URL(rawUrl, window.location.href);
    } catch {
      return nativeFetch(input, init);
    }
    if (url.origin !== window.location.origin || !cacheablePaths.has(url.pathname)) {
      return nativeFetch(input, init);
    }

    if (url.pathname === '/api/track-history' && url.searchParams.get('latest') !== '1') {
      url.searchParams.set('v', '10');
    } else if (url.pathname === '/api/history') {
      url.searchParams.set('v', '11');
    }
    const options = { ...init };
    if (options.cache === 'no-store') delete options.cache;
    return nativeFetch(url.toString(), options);
  };
})();
