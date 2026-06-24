import app from './resilient-index.js';

const nativeFetch = globalThis.fetch.bind(globalThis);
const API_ORIGIN = 'https://production1.stationhead.com';

function isChatHistory(url) {
  return url.origin === API_ORIGIN && /\/station\/[^/]+\/chatHistory$/i.test(url.pathname);
}

function cloneInit(init = {}) {
  return {
    ...init,
    headers: init.headers ? new Headers(init.headers) : undefined,
    signal: AbortSignal.timeout(20_000),
  };
}

function emptyChatResponse(limit, reason) {
  console.warn(JSON.stringify({
    event: 'stationhead_chat_history_skipped',
    attempted_limit: limit,
    reason,
  }));
  return new Response(JSON.stringify({ chats: { items: [], next: null } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const rawUrl = typeof input === 'string' ? input : input?.url;
  if (!rawUrl) return nativeFetch(input, init);

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return nativeFetch(input, init);
  }

  if (!isChatHistory(url)) return nativeFetch(input, init);

  const requested = Math.max(1, Number(url.searchParams.get('limit')) || 100);
  const limits = [...new Set([requested, Math.min(requested, 50), Math.min(requested, 20)])];
  let lastReason = 'unknown';

  for (const limit of limits) {
    const retryUrl = new URL(url);
    retryUrl.searchParams.set('limit', String(limit));
    try {
      const response = await nativeFetch(retryUrl.toString(), cloneInit(init));
      if (response.status !== 504) {
        if (limit !== requested) {
          console.warn(JSON.stringify({
            event: 'stationhead_chat_history_fallback',
            requested_limit: requested,
            successful_limit: limit,
          }));
        }
        return response;
      }
      lastReason = `HTTP 504 at limit=${limit}`;
      await response.arrayBuffer().catch(() => {});
    } catch (error) {
      const message = String(error?.message || error);
      if (!/timeout|timed out|aborted/i.test(message)) throw error;
      lastReason = `${message} at limit=${limit}`;
    }
  }

  return emptyChatResponse(requested, lastReason);
};

export default app;
