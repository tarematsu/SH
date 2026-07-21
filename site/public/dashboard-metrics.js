import { renderDashboardDailySummaries } from './dashboard-daily-summaries.js';

const DASHBOARD_CACHE_KEY = 'sh.dashboard.v3';
const nativeFetch = window.fetch.bind(window);

function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return String(input);
  return input?.url || '';
}

function renderPayload(payload) {
  if (payload?.ok) renderDashboardDailySummaries(payload.daily_summaries);
}

function restoreDashboardCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(DASHBOARD_CACHE_KEY) || 'null');
    if (!cached || Date.now() - Number(cached.savedAt || 0) > 6 * 60 * 60_000) return;
    renderPayload(cached.payload);
  } catch {
    localStorage.removeItem(DASHBOARD_CACHE_KEY);
  }
}

async function captureDashboard(input, response) {
  if (!response.ok) return;
  const url = requestUrl(input);
  if (!url || new URL(url, location.href).pathname !== '/api/dashboard') return;
  try {
    renderPayload(await response.clone().json());
  } catch {
    // The dashboard client owns request error reporting.
  }
}

window.fetch = async (input, init) => {
  const response = await nativeFetch(input, init);
  void captureDashboard(input, response);
  return response;
};

restoreDashboardCache();
void import('/dashboard-client.js').catch((error) => {
  console.error('dashboard client failed to start', error);
  const status = document.getElementById('statusMessage');
  if (status) {
    status.textContent = '画面の初期化に失敗しました。再読み込みしてください。';
    status.hidden = false;
  }
});
