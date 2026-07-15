const DASHBOARD_CACHE_KEY = 'sh.dashboard-lite.v1';
const DAILY_REFRESH_MS = 5 * 60_000;
const integer = new Intl.NumberFormat('ja-JP');
const nativeFetch = window.fetch.bind(window);
let loadedUtcDay = '';

const byId = (id) => document.getElementById(id);
const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function setText(id, value) {
  const node = byId(id);
  if (node && node.textContent !== String(value)) node.textContent = String(value);
}

function formatNumber(value) {
  const number = finite(value);
  return number == null ? '—' : integer.format(number);
}

function renderLatest(payload) {
  const latest = payload?.latest || {};
  setText('totalStreams', formatNumber(latest.current_stream_count ?? latest.total_stream_count));
}

function renderDelta(id, label, value) {
  const node = byId(id);
  if (!node) return;
  const number = finite(value);
  node.className = 'delta';
  if (number == null) {
    node.textContent = `${label} —`;
  } else {
    const sign = number < 0 ? '−' : '+';
    node.textContent = `${label} ${sign}${integer.format(Math.abs(number))}`;
    if (number > 0) node.classList.add('positive');
    if (number < 0) node.classList.add('negative');
  }
  node.hidden = false;
}

function renderDailyChanges(data) {
  renderDelta('membersYesterdayDelta', '昨日', data?.yesterday?.member_growth);
  renderDelta('membersDayBeforeDelta', '一昨日', data?.day_before_yesterday?.member_growth);
  renderDelta('streamsYesterdayDelta', '昨日', data?.yesterday?.stream_growth);
  renderDelta('streamsDayBeforeDelta', '一昨日', data?.day_before_yesterday?.stream_growth);
}

async function loadDailyChanges() {
  const utcDay = new Date().toISOString().slice(0, 10);
  if (utcDay === loadedUtcDay) return;
  try {
    const response = await nativeFetch(`/api/dashboard-daily-changes?day=${encodeURIComponent(utcDay)}`, {
      headers: { accept: 'application/json' },
    });
    const data = await response.json();
    if (!response.ok || !data?.ok) throw new Error(data?.error || `daily changes API ${response.status}`);
    renderDailyChanges(data);
    loadedUtcDay = utcDay;
  } catch (error) {
    console.error('dashboard UTC daily metrics failed to load', error);
    renderDailyChanges(null);
  }
}

function restoreDashboardCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(DASHBOARD_CACHE_KEY) || 'null');
    if (!cached || Date.now() - Number(cached.savedAt || 0) > 6 * 60 * 60 * 1000) return;
    if (cached.payload?.ok) renderLatest(cached.payload);
  } catch {
    // The live dashboard request will populate the metric when storage is unavailable.
  }
}

function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return String(input);
  return input?.url || '';
}

async function captureDashboard(input, response) {
  if (!response.ok) return;
  const url = requestUrl(input);
  if (!url || new URL(url, location.href).pathname !== '/api/dashboard') return;
  try {
    const payload = await response.clone().json();
    if (payload?.ok) renderLatest(payload);
  } catch {
    // The primary dashboard client owns request error reporting.
  }
}

window.fetch = async (input, init) => {
  const response = await nativeFetch(input, init);
  void captureDashboard(input, response);
  return response;
};

restoreDashboardCache();
void loadDailyChanges();
setInterval(() => {
  if (!document.hidden) void loadDailyChanges();
}, DAILY_REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void loadDailyChanges();
});
void import('/app-main.js').catch((error) => {
  console.error('dashboard client failed to start', error);
  const status = byId('statusMessage');
  if (status) {
    status.textContent = '画面の初期化に失敗しました。再読み込みしてください。';
    status.hidden = false;
  }
});
