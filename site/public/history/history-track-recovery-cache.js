(() => {
  const previousFetch = window.fetch.bind(window);
  window.fetch = function fetchWithTrackRecoveryVersion(input, init = {}) {
    const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (!rawUrl) return previousFetch(input, init);
    try {
      const url = new URL(rawUrl, window.location.href);
      if (url.origin === window.location.origin
          && url.pathname === '/api/track-history'
          && url.searchParams.get('latest') !== '1') {
        url.searchParams.set('recovery', '2');
        return previousFetch(url.toString(), init);
      }
    } catch {}
    return previousFetch(input, init);
  };
})();
