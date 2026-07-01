(() => {
  const nativeFetch = window.fetch.bind(window);

  window.fetch = function fetchWithTrackHistoryCache(input, init = {}) {
    const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (!rawUrl) return nativeFetch(input, init);

    let url;
    try {
      url = new URL(rawUrl, window.location.href);
    } catch {
      return nativeFetch(input, init);
    }
    if (url.origin !== window.location.origin || url.pathname !== '/api/track-history') {
      return nativeFetch(input, init);
    }

    if (url.searchParams.get('latest') !== '1') url.searchParams.set('v', '10');
    const options = { ...init };
    if (options.cache === 'no-store') delete options.cache;
    return nativeFetch(url.toString(), options);
  };
})();
