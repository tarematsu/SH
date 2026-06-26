(() => {
  const baseRefresh = refresh;
  const minIntervalMs = 110 * 1000;
  let lastStartedAt = 0;

  refresh = async function throttledRefresh(options = {}) {
    const now = Date.now();
    const forced = Boolean(options?.force);
    if (refreshInFlight || (!forced && now - lastStartedAt < minIntervalMs)) return;
    lastStartedAt = now;
    return baseRefresh();
  };
})();
