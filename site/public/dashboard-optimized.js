(() => {
  const baseRefresh = refresh;
  const minIntervalMs = 110 * 1000;
  let lastStartedAt = Date.now();

  refresh = async function throttledRefresh() {
    const now = Date.now();
    if (refreshInFlight || now - lastStartedAt < minIntervalMs) return;
    lastStartedAt = now;
    return baseRefresh();
  };
})();
