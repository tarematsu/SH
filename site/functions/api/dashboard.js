import { onRequestGet as dashboardCore } from '../lib/dashboard-core.js';
import { loadDashboardDailySummaries } from '../lib/dashboard-daily-summaries.js';

export * from '../lib/dashboard-core.js';

async function dailySummaries(env, now) {
  try {
    return await loadDashboardDailySummaries(env?.OTHER_DB, now);
  } catch (error) {
    console.error(error);
    return loadDashboardDailySummaries(null, now);
  }
}

function factsOnlyDashboardContext(context) {
  const env = Object.create(context.env || null);
  // dashboard-core still contains a rollout-era DB fallback. The public and
  // materialization entry point deliberately masks that binding so stale facts
  // fail closed instead of executing the legacy multi-million-row query.
  Object.defineProperty(env, 'DB', {
    value: null,
    enumerable: true,
    configurable: true,
  });
  return { ...context, env };
}

export async function onRequestGet(context) {
  const now = Date.now();
  const [response, summaries] = await Promise.all([
    dashboardCore(factsOnlyDashboardContext(context)),
    dailySummaries(context.env, now),
  ]);
  if (!response.ok) return response;

  let payload;
  try {
    payload = await response.json();
  } catch {
    return response;
  }
  if (!payload || typeof payload !== 'object' || !payload.ok) return response;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify({
    ...payload,
    daily_summaries: summaries,
  }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
