(() => {
  const nativeFetch = window.fetch.bind(window);
  const state = {
    latestObservedAt: 0,
    queueRevision: '',
    history: [],
    queue: [],
    queueStatus: null,
    lastPayload: null,
  };

  function dashboardUrl(input) {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (!raw) return null;
    const url = new URL(raw, window.location.href);
    if (url.origin !== window.location.origin || url.pathname !== '/api/dashboard') return null;
    return url;
  }

  function mergeHistory(previous, incoming) {
    const rows = new Map();
    for (const row of [...(previous || []), ...(incoming || [])]) {
      const observedAt = Number(row?.observed_at);
      if (Number.isFinite(observedAt)) rows.set(observedAt, row);
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return [...rows.values()]
      .filter((row) => Number(row.observed_at) >= cutoff)
      .sort((left, right) => Number(left.observed_at) - Number(right.observed_at))
      .slice(-300);
  }

  function mergePayload(payload) {
    if (!payload?.ok) return payload;
    if (payload.delta) {
      state.history = mergeHistory(state.history, payload.history);
      payload.history = state.history;
      if (payload.queue_unchanged) {
        payload.queue = state.queue;
        payload.queue_status = { ...(state.queueStatus || {}), ...(payload.queue_status || {}) };
      } else {
        state.queue = Array.isArray(payload.queue) ? payload.queue : [];
        state.queueStatus = payload.queue_status || null;
      }
      payload.delta = false;
    } else {
      state.history = mergeHistory([], payload.history);
      state.queue = Array.isArray(payload.queue) ? payload.queue : [];
      state.queueStatus = payload.queue_status || null;
    }

    state.latestObservedAt = Math.max(
      state.latestObservedAt,
      Number(payload.latest_observed_at || payload.latest?.observed_at || 0),
    );
    if (payload.queue_revision) state.queueRevision = String(payload.queue_revision);
    state.lastPayload = structuredClone(payload);
    return payload;
  }

  function cachedResponse() {
    if (!state.lastPayload) return null;
    return new Response(JSON.stringify(structuredClone(state.lastPayload)), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-dashboard-cache': 'hidden-tab',
      },
    });
  }

  window.fetch = async (input, init = {}) => {
    const url = dashboardUrl(input);
    if (!url || String(init?.method || input?.method || 'GET').toUpperCase() !== 'GET') {
      return nativeFetch(input, init);
    }

    if (document.hidden) {
      const cached = cachedResponse();
      if (cached) return cached;
    }

    if (state.latestObservedAt > 0) url.searchParams.set('since', String(state.latestObservedAt));
    if (state.queueRevision) url.searchParams.set('queue_revision', state.queueRevision);

    const requestInput = input instanceof Request
      ? new Request(url.toString(), input)
      : url.toString();
    const response = await nativeFetch(requestInput, init);
    if (!response.ok) return response;

    try {
      const payload = mergePayload(await response.clone().json());
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(JSON.stringify(payload), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      return response;
    }
  };
})();
