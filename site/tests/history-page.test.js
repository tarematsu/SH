import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const historyPage = readFileSync(new URL('../public/history/index.html', import.meta.url), 'utf8');
const historyEntry = readFileSync(new URL('../public/history/history-main.js', import.meta.url), 'utf8');
const historyClient = readFileSync(new URL('../public/history/history-lite.js', import.meta.url), 'utf8');
const historyStyles = readFileSync(new URL('../public/history/history-lite.css', import.meta.url), 'utf8');
const likesPage = readFileSync(new URL('../public/history/likes/index.html', import.meta.url), 'utf8');
const likesClient = readFileSync(new URL('../public/history/history-likes.js', import.meta.url), 'utf8');
const middleware = readFileSync(new URL('../functions/api/_middleware.js', import.meta.url), 'utf8');

test('history page keeps every public mode and links the like ranking tab', () => {
  for (const mode of ['current', 'daily', 'weekly', 'ranking', 'monthly', 'tracks', 'broadcasts']) {
    assert.match(historyPage, new RegExp(`data-mode="${mode}"`));
  }
  assert.match(historyPage, /href="\/history\/likes\/">いいね<\/a>/);
  assert.equal((historyPage.match(/<link rel="stylesheet"/g) || []).length, 1);
  assert.equal((historyPage.match(/<script /g) || []).length, 1);
  assert.match(historyPage, /type="module" src="\/history\/history-main\.js"/);
  assert.match(historyEntry, /import\('\/history\/history-lite\.js'\)/);
  assert.doesNotMatch(historyPage, /history-copy-fixes\.js/);
});

test('history defaults to current and loads the fixed 24-hour audience endpoint on access', () => {
  assert.match(historyPage, /data-mode="current" class="active"/);
  assert.match(historyPage, /id="audienceChart"/);
  assert.match(historyPage, /オンライン・コメント勢い（24時間）/);
  assert.match(historyEntry, /const HISTORY_URL = '\/api\/dashboard-history'/);
  assert.match(historyEntry, /loadAudience\(\);\s*await import/);
  assert.match(historyEntry, /online_member_count/);
  assert.match(historyEntry, /comment_velocity/);
  assert.match(historyEntry, /Date\.now\(\) - DAY_MS/);
  assert.doesNotMatch(historyEntry, /current_stream_count/);
});

test('history page removes explanatory copy and uses compact main-dashboard controls', () => {
  assert.doesNotMatch(historyPage, /スマホ向けに軽く表示/);
  assert.match(historyPage, /id="guideText" hidden/);
  assert.match(historyPage, /class="date-range"/);
  assert.match(historyPage, />更新<\/button>/);
  assert.match(historyStyles, /body \{[^}]*radial-gradient/);
  assert.match(historyStyles, /--radius:\s*20px/);
  assert.match(historyStyles, /\.controls \{[^}]*grid-template-columns/);
  assert.match(historyStyles, /\.date-range \{[^}]*grid-template-columns/);
  assert.match(historyStyles, /\.range-presets \{[^}]*repeat\(4/);
});

test('history client preserves current, summary, ranking, tracks and broadcast endpoints', () => {
  assert.match(historyClient, /\/api\/history-current\?latest=1/);
  assert.match(historyClient, /\/api\/history\?/);
  assert.match(historyClient, /\/api\/track-history\?latest=1/);
  assert.match(historyClient, /\/api\/track-history\?\$\{/);
  assert.match(historyClient, /\/api\/broadcast-series\?/);
  assert.match(historyClient, /weekly_metrics/);
  assert.match(historyClient, /like_count/);
  assert.match(historyClient, /broadcastSeries/);
});

test('history client reduces repeated reads with shared URLs and browser session caching', () => {
  assert.match(historyClient, /sessionStorage\.getItem/);
  assert.match(historyClient, /sessionStorage\.setItem/);
  assert.match(historyClient, /ttl:\s*60_000/);
  assert.match(historyClient, /ttl:\s*5 \* 60_000/);
  assert.match(historyClient, /ttl:\s*10 \* 60_000/);
  assert.doesNotMatch(historyClient, /cache:\s*['"]no-store['"]/);
  assert.doesNotMatch(historyClient, /searchParams\.set\(['"]v/);
});

test('history tables render newest summary rows first and paginate only in the browser', () => {
  assert.match(historyClient, /\['current', 'daily', 'weekly', 'monthly', 'broadcasts'\]\.includes\(mode\)/);
  assert.match(historyClient, /return \[\.\.\.rows\]\.reverse\(\)/);
  assert.match(historyClient, /const PAGE_SIZE = 200/);
  assert.match(historyClient, /state\.visibleRows \+= PAGE_SIZE/);
  assert.match(historyClient, /exportCsv/);
});

test('likes tab shows latest like counts beside this week play counts', () => {
  assert.match(likesPage, /aria-current="page" href="\/history\/likes\/">いいね<\/a>/);
  assert.match(likesPage, /最新いいね/);
  assert.match(likesPage, /今週再生/);
  assert.doesNotMatch(likesPage, /期間内いいね合計|1回平均|順位基準/);
  assert.equal((likesPage.match(/<link rel="stylesheet"/g) || []).length, 1);
  assert.equal((likesPage.match(/<script /g) || []).length, 1);
  assert.match(likesClient, /\/api\/like-ranking\?limit=500/);
  assert.match(likesClient, /\/api\/track-history\?/);
  assert.match(likesClient, /mondayUtc/);
  assert.match(likesClient, /latest_like_count/);
  assert.match(likesClient, /week_play_count/);
  assert.doesNotMatch(likesClient, /total_like_count|peak_like_count|average_like_count/);
});

test('edge middleware shares current, track-history and like-ranking D1 reads', () => {
  assert.match(middleware, /url\.pathname === '\/api\/history-current'/);
  assert.match(middleware, /ttl: 60, browser: 30/);
  assert.match(middleware, /url\.pathname === '\/api\/track-history'/);
  assert.match(middleware, /url\.pathname === '\/api\/like-ranking'/);
  assert.match(middleware, /ttl: 900, browser: 300/);
});
