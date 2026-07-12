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

  function hasUsableQueue() {
    return Array.isArray(state.queue) && state.queue.length > 0;
  }

  function sameGoal(payload) {
    const currentGoal = Number(payload?.latest?.stream_goal);
    const previousGoal = Number(state.lastPayload?.latest?.stream_goal);
    return !Number.isFinite(currentGoal)
      || !Number.isFinite(previousGoal)
      || currentGoal === previousGoal;
  }

  function alreadyReachedGoal(payload) {
    const current = Number(payload?.latest?.current_stream_count);
    const goal = Number(payload?.latest?.stream_goal);
    return Number.isFinite(current) && Number.isFinite(goal) && goal > 0 && current >= goal;
  }

  function mergeGoalPrediction(payload) {
    if (payload?.goal_prediction || !sameGoal(payload) || alreadyReachedGoal(payload)) return;
    const previous = state.lastPayload?.goal_prediction;
    if (previous) payload.goal_prediction = structuredClone(previous);
  }

  function mergeGoalPredictions(payload) {
    if (Array.isArray(payload?.goal_predictions) && payload.goal_predictions.length) return;
    if (!sameGoal(payload)) return;
    const previous = state.lastPayload?.goal_predictions;
    if (Array.isArray(previous) && previous.length) payload.goal_predictions = structuredClone(previous);
  }

  function mergePayload(payload) {
    if (!payload?.ok) return payload;
    if (payload.delta) {
      state.history = mergeHistory(state.history, payload.history);
      payload.history = state.history;
      if (payload.queue_unchanged && hasUsableQueue()) {
        payload.queue = state.queue;
        payload.queue_status = { ...(state.queueStatus || {}), ...(payload.queue_status || {}) };
      } else {
        payload.queue_unchanged = false;
        state.queue = Array.isArray(payload.queue) ? payload.queue : [];
        state.queueStatus = payload.queue_status || null;
      }
      mergeGoalPrediction(payload);
      mergeGoalPredictions(payload);
      payload.delta = false;
    } else {
      state.history = mergeHistory([], payload.history);
      state.queue = Array.isArray(payload.queue) ? payload.queue : [];
      state.queueStatus = payload.queue_status || null;
      mergeGoalPrediction(payload);
      mergeGoalPredictions(payload);
    }

    state.latestObservedAt = Math.max(
      state.latestObservedAt,
      Number(payload.latest_observed_at || payload.latest?.observed_at || 0),
    );
    if (payload.queue_revision && hasUsableQueue()) state.queueRevision = String(payload.queue_revision);
    if (!hasUsableQueue()) state.queueRevision = '';
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
    if (state.queueRevision && hasUsableQueue()) url.searchParams.set('queue_revision', state.queueRevision);
    if (!hasUsableQueue()) url.searchParams.delete('queue_revision');

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
