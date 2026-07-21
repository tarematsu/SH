import { onRequestGet as dashboardCore } from './dashboard-core.js';
import { loadDashboardDailySummaries } from '../lib/dashboard-daily-summaries.js';

export * from './dashboard-core.js';

async function dailySummaries(env, now) {
  try {
    return await loadDashboardDailySummaries(env?.OTHER_DB, now);
  } catch (error) {
    console.error(error);
    return loadDashboardDailySummaries(null, now);
  }
}

export async function onRequestGet(context) {
  const now = Date.now();
  const [response, summaries] = await Promise.all([
    dashboardCore(context),
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
