import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const mainPage = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dashboardEntry = readFileSync(new URL('../public/dashboard-metrics.js', import.meta.url), 'utf8');
const dashboardDaily = readFileSync(new URL('../public/dashboard-daily-summaries.js', import.meta.url), 'utf8');
const dashboardClient = readFileSync(new URL('../public/dashboard-client.js', import.meta.url), 'utf8');
const historyEntry = readFileSync(new URL('../public/history/history-main.js', import.meta.url), 'utf8');
const historyFixes = readFileSync(new URL('../public/history/history-page-fixes.js', import.meta.url), 'utf8');
const trackEndpoint = readFileSync(new URL('../functions/api/track-history.js', import.meta.url), 'utf8');

test('main page renders current track likes from the dashboard response', () => {
  assert.match(mainPage, /id="trackBites" hidden/);
  assert.equal((mainPage.match(/<script /g) || []).length, 1);
  assert.match(mainPage, /src="\/dashboard-metrics\.js"/);
  assert.match(dashboardEntry, /import\('\/dashboard-client\.js'\)/);
  assert.match(dashboardClient, /track\.bite_count/);
  assert.match(dashboardClient, /`♡ \$\{integer\.format\(bites\)\}`/);
  assert.equal((dashboardClient.match(/\/api\/dashboard/g) || []).length, 1);
  assert.match(dashboardClient, /payload\.queue/);
  assert.match(dashboardClient, /payload\.history/);
});

test('main page labels member and stream deltas with their actual dates', () => {
  assert.match(dashboardEntry, /renderDashboardDailySummaries/);
  assert.match(dashboardDaily, /formatPeriodLabel\(data\?\.yesterday\?\.period_key, '昨日'\)/);
  assert.match(dashboardDaily, /formatPeriodLabel\(data\?\.day_before_yesterday\?\.period_key, '一昨日'\)/);
  assert.match(dashboardDaily, /`\$\{Number\(match\[2\]\)\}月\$\{Number\(match\[3\]\)\}日`/);
  assert.match(dashboardDaily, /streamsYesterdayDelta', yesterdayLabel/);
  assert.match(dashboardDaily, /streamsDayBeforeDelta', dayBeforeLabel/);
});

test('track history reads materialized rows and integrated ranking status', () => {
  assert.match(trackEndpoint, /FROM sh_pages_track_history_read_model/);
  assert.match(trackEndpoint, /FROM sh_pages_payload_read_model/);
  assert.match(trackEndpoint, /ranking_summary/);
  assert.match(trackEndpoint, /ranking_scope/);
  assert.match(trackEndpoint, /worker_materialized_read_model/);
});

test('track history defaults to yesterday as a single day', () => {
  assert.match(historyEntry, /Date\.now\(\) - 86_400_000/);
  assert.match(historyEntry, /trackDate\.value = yesterday/);
  assert.match(historyEntry, /trackWeekMode\.checked = false/);
});

test('track history is presented as a daily play-count ranking card view', () => {
  assert.match(historyEntry, /import\('\/history\/history-page-fixes\.js'\)/);
  assert.match(historyFixes, /labels\.indexOf\('再生回数'\)/);
  assert.match(historyFixes, /\.sort\(\(left, right\) =>/);
  assert.match(historyFixes, /1日の再生数ランキング/);
  assert.match(historyFixes, /className = 'like-rank-item'/);
  assert.match(historyFixes, /metric\('再生回数'/);
  assert.match(historyFixes, /metric\('いいね数'/);
  assert.match(historyFixes, /tableWrap\.hidden = true/);
});

test('sparse daily summaries draw visible point markers instead of an empty canvas', () => {
  assert.match(historyFixes, /location\.hash !== '#daily'/);
  assert.match(historyFixes, /state\.lines > 0/);
  assert.match(historyFixes, /this\.arc\(x, y, 3/);
});
