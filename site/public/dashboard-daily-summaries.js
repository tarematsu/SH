const integer = new Intl.NumberFormat('ja-JP');

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatPeriodLabel(periodKey, fallback) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(periodKey || ''));
  return match ? `${Number(match[2])}月${Number(match[3])}日` : fallback;
}

function renderDelta(id, label, value) {
  const node = document.getElementById(id);
  if (!node) return;
  const number = finite(value);
  node.className = 'delta';
  node.textContent = number == null
    ? `${label} —`
    : `${label} ${number < 0 ? '−' : '+'}${integer.format(Math.abs(number))}`;
  if (number > 0) node.classList.add('positive');
  if (number < 0) node.classList.add('negative');
  node.hidden = false;
}

export function renderDashboardDailySummaries(data) {
  const yesterdayLabel = formatPeriodLabel(data?.yesterday?.period_key, '昨日');
  const dayBeforeLabel = formatPeriodLabel(data?.day_before_yesterday?.period_key, '一昨日');
  renderDelta('membersYesterdayDelta', yesterdayLabel, data?.yesterday?.member_growth);
  renderDelta('membersDayBeforeDelta', dayBeforeLabel, data?.day_before_yesterday?.member_growth);
  renderDelta('streamsYesterdayDelta', yesterdayLabel, data?.yesterday?.stream_growth);
  renderDelta('streamsDayBeforeDelta', dayBeforeLabel, data?.day_before_yesterday?.stream_growth);
}
