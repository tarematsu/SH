const inFlight = new Map();

function cachePolicy(url) {
  if (url.pathname === '/api/dashboard') return { ttl: 60, browser: 30 };
  if (url.pathname === '/api/broadcast-series') return { ttl: 3600, browser: 300 };
  if (url.pathname === '/api/history') {
    const mode = url.searchParams.get('mode') || 'weekly';
    if (mode === 'raw' || url.searchParams.has('cursor')) return null;
    if (mode === 'broadcasts' || mode === 'ranking') return { ttl: 900, browser: 120 };
    return { ttl: 300, browser: 60 };
  }
  return null;
}

function canonicalRequest(request) {
  const url = new URL(request.url);
  url.searchParams.delete('v');
  const sorted = [...url.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) =>
    aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
  url.search = '';
  for (const [key, value] of sorted) url.searchParams.append(key, value);
  return new Request(url.toString(), {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
}

function tagged(response, state) {
  const clone = response.clone();
  const headers = new Headers(clone.headers);
  headers.set('x-edge-cache', state);
  return new Response(clone.body, {
    status: clone.status,
    statusText: clone.statusText,
    headers,
  });
}

function jsonResponse(response, payload) {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function utcDayRange(now = Date.now()) {
  const date = new Date(now);
  const currentStart = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
  return { previousStart: currentStart - 86_400_000, currentStart };
}

function hostScope(latest) {
  const accountId = Number(latest?.host_account_id);
  if (Number.isFinite(accountId) && accountId > 0) {
    return { column: 'host_account_id', value: accountId };
  }
  const handle = String(latest?.host_handle || '').trim();
  return handle ? { column: 'host_handle', value: handle } : null;
}

async function previousMetric(db, metric, scope, range) {
  if (!db || !['total_member_count', 'total_listens'].includes(metric)) return null;
  const hostClause = scope ? ` AND ${scope.column}=?` : '';
  const statement = db.prepare(`SELECT observed_at,${metric}
    FROM sh_channel_snapshots
    WHERE observed_at>=? AND observed_at<?${hostClause}
      AND ${metric} IS NOT NULL
    ORDER BY observed_at DESC,id DESC LIMIT 1`);
  return scope
    ? statement.bind(range.previousStart, range.currentStart, scope.value).first()
    : statement.bind(range.previousStart, range.currentStart).first();
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function withUtcDashboard(response, db) {
  try {
    const payload = await response.clone().json();
    if (!payload?.ok || !payload.latest) return response;
    const range = utcDayRange();
    const scope = hostScope(payload.latest);
    const [memberBaseline, listensBaseline] = await Promise.all([
      previousMetric(db, 'total_member_count', scope, range),
      previousMetric(db, 'total_listens', scope, range),
    ]);
    const latestMembers = finite(payload.latest.total_member_count);
    const latestListens = finite(payload.latest.total_listens);
    const previousMembers = finite(memberBaseline?.total_member_count);
    const previousListens = finite(listensBaseline?.total_listens);

    payload.timezone = 'UTC';
    payload.daily_change = {
      host_account_id: payload.latest.host_account_id ?? null,
      host_handle: payload.latest.host_handle ?? null,
      timezone: 'UTC',
      period_start: range.previousStart,
      period_end: range.currentStart,
      member_baseline_observed_at: memberBaseline?.observed_at ?? null,
      listens_baseline_observed_at: listensBaseline?.observed_at ?? null,
      member_cutoff_hour_utc: 0,
      listens_cutoff_hour_utc: 0,
      total_member_count: latestMembers != null && previousMembers != null
        ? latestMembers - previousMembers : null,
      total_listens: latestListens != null && previousListens != null
        ? latestListens - previousListens : null,
    };
    return jsonResponse(response, payload);
  } catch (error) {
    console.error('UTC dashboard normalization failed', error);
    return response;
  }
}

async function withUtcRawHistory(response) {
  try {
    const payload = await response.clone().json();
    if (!payload?.ok || payload.mode !== 'raw') return response;
    payload.timezone = 'UTC';
    payload.rows = (payload.rows || []).map((row) => {
      const observedAt = Number(row?.observed_at);
      const observedUtc = Number.isFinite(observedAt)
        ? new Date(observedAt).toISOString().replace('.000Z', 'Z')
        : row?.observed_utc ?? null;
      return {
        ...row,
        observed_utc: observedUtc,
        observed_jst: observedUtc,
      };
    });
    return jsonResponse(response, payload);
  } catch (error) {
    console.error('UTC raw-history normalization failed', error);
    return response;
  }
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'GET' || request.headers.has('authorization')) return context.next();

  const url = new URL(request.url);
  const policy = cachePolicy(url);
  if (!policy) {
    let response = await context.next();
    if (url.pathname === '/api/history' && url.searchParams.get('mode') === 'raw' && response.ok) {
      response = await withUtcRawHistory(response);
    }
    return response;
  }

  const cache = caches.default;
  const cacheKey = canonicalRequest(request);
  const hit = await cache.match(cacheKey);
  if (hit) return tagged(hit, 'HIT');

  const key = cacheKey.url;
  let task = inFlight.get(key);
  const coalesced = Boolean(task);

  if (!task) {
    task = (async () => {
      let origin = await context.next();
      if (url.pathname === '/api/dashboard' && origin.ok) {
        origin = await withUtcDashboard(origin, context.env?.DB);
      }
      const headers = new Headers(origin.headers);
      if (origin.ok) {
        headers.set('cache-control', `public, max-age=${policy.browser}, s-maxage=${policy.ttl}, stale-while-revalidate=${policy.ttl * 2}`);
      }
      headers.set('vary', 'accept-encoding');
      const shared = new Response(origin.body, {
        status: origin.status,
        statusText: origin.statusText,
        headers,
      });
      if (shared.ok) context.waitUntil(cache.put(cacheKey, shared.clone()));
      return shared;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, task);
  }

  const response = await task;
  return tagged(response, coalesced ? 'COALESCED' : 'MISS');
}
