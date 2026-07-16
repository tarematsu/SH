import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const mainPage = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dashboardClient = readFileSync(new URL('../public/dashboard-metrics.js', import.meta.url), 'utf8');
const historyEntry = readFileSync(new URL('../public/history/history-main.js', import.meta.url), 'utf8');
const historyFixes = readFileSync(new URL('../public/history/history-page-fixes.js', import.meta.url), 'utf8');
const trackEndpoint = readFileSync(new URL('../functions/api/track-history.js', import.meta.url), 'utf8');

test('main page renders the current track bite count from the existing dashboard response', () => {
  assert.match(mainPage, /id="trackBites" hidden/);
  assert.equal((mainPage.match(/<script /g) || []).length, 1);
  assert.match(mainPage, /src="\/dashboard-metrics\.js"/);
  assert.match(dashboardClient, /current\?\.bite_count/);
  assert.match(dashboardClient, /`♡ \$\{integer\.format\(count\)\}`/);
  assert.doesNotMatch(dashboardClient, /fetch\(['"]\/api\/playback/);
});

test('main page labels member and stream deltas with their actual dates', () => {
  assert.match(dashboardClient, /formatPeriodLabel\(data\?\.yesterday\?\.period_key, '昨日'\)/);
  assert.match(dashboardClient, /formatPeriodLabel\(data\?\.day_before_yesterday\?\.period_key, '一昨日'\)/);
  assert.match(dashboardClient, /`\$\{Number\(match\[2\]\)\}月\$\{Number\(match\[3\]\)\}日`/);
  assert.match(dashboardClient, /streamsYesterdayDelta', yesterdayLabel/);
  assert.match(dashboardClient, /streamsDayBeforeDelta', dayBeforeLabel/);
});

test('track history reads only the materialized MINUTE_DB read model', () => {
  assert.match(trackEndpoint, /FROM sh_pages_track_history_read_model/);
  assert.match(trackEndpoint, /FROM sh_pages_payload_read_model/);
  assert.doesNotMatch(trackEndpoint, /handleTrackHistory|sh_queue_items|sh_queue_snapshots|sh_channel_snapshots/);
});

test('track history defaults to yesterday as a single day', () => {
  assert.match(historyEntry, /Date\.now\(\) - 86_400_000/);
  assert.match(historyEntry, /trackDate\.value = yesterday/);
  assert.match(historyEntry, /trackWeekMode\.checked = false/);
});

test('track history is presented as a daily play-count ranking using like-ranking cards', () => {
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
