const EMAIL_RECAP_PATH = '/ingest/email-recap';
const RUN_PATH = '/run';
const DEFAULT_REPLAY_TTL_MS = 10 * 60 * 1000;
const MAX_REPLAY_ENTRIES = 32;

export function isRealIsoDate(value) {
  const text = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function replayTtl(env = {}) {
  const value = Number(env.EMAIL_RECAP_REPLAY_TTL_MS ?? DEFAULT_REPLAY_TTL_MS);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 60 * 60 * 1000) : DEFAULT_REPLAY_TTL_MS;
}

function replayKey(request, bodyText) {
  const authorization = request.headers.get('authorization') || '';
  return `${authorization}\n${bodyText}`;
}

function cloneStored(stored, replayed = false) {
  const headers = new Headers(stored.headers);
  if (replayed) headers.set('x-idempotent-replay', '1');
  return new Response(stored.body, { status: stored.status, headers });
}

export function createRequestHardenedApp(app, nowFn = Date.now) {
  const completed = new Map();
  const flights = new Map();

  function prune(now) {
    for (const [key, value] of completed) {
      if (value.expiresAt <= now) completed.delete(key);
    }
    while (completed.size > MAX_REPLAY_ENTRIES) completed.delete(completed.keys().next().value);
  }

  return {
    scheduled(controller, env, ctx) {
      return app.scheduled(controller, env, ctx);
    },

    async fetch(request, env, ctx) {
      const url = new URL(request.url);

      if (request.method === 'POST' && url.pathname === EMAIL_RECAP_PATH) {
        const bodyText = await request.clone().text();
        let body;
        try {
          body = JSON.parse(bodyText);
        } catch {
          return app.fetch(request, env, ctx);
        }
        if (!isRealIsoDate(body?.week_of)) {
          return json({ ok: false, error: 'invalid week_of' }, 400);
        }

        const now = Number(nowFn()) || Date.now();
        prune(now);
        const key = replayKey(request, bodyText);
        const cached = completed.get(key);
        if (cached && cached.expiresAt > now) return cloneStored(cached, true);
        if (flights.has(key)) return cloneStored(await flights.get(key), true);

        const flight = Promise.resolve(app.fetch(request, env, ctx)).then(async (response) => {
          const stored = {
            status: response.status,
            headers: [...response.headers.entries()],
            body: await response.clone().text(),
            expiresAt: now + replayTtl(env),
          };
          if (response.ok) completed.set(key, stored);
          return stored;
        }).finally(() => flights.delete(key));
        flights.set(key, flight);
        return cloneStored(await flight);
      }

      const response = await app.fetch(request, env, ctx);
      if (request.method === 'POST' && url.pathname === RUN_PATH && response.status >= 500) {
        return json({ ok: false, error: 'collection failed' }, response.status);
      }
      return response;
    },
  };
}
