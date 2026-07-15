import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const historyPage = readFileSync(new URL('../public/history/index.html', import.meta.url), 'utf8');
const historyEntry = readFileSync(new URL('../public/history/history-main.js', import.meta.url), 'utf8');
const historyClient = readFileSync(new URL('../public/history/history-lite.js', import.meta.url), 'utf8');
const historyStyles = readFileSync(new URL('../public/history/history-lite.css', import.meta.url), 'utf8');
const mainStyles = readFileSync(new URL('../public/app-lite.css', import.meta.url), 'utf8');
const likesPage = readFileSync(new URL('../public/history/likes/index.html', import.meta.url), 'utf8');
const likesClient = readFileSync(new URL('../public/history/history-likes.js', import.meta.url), 'utf8');
const likeApi = readFileSync(new URL('../functions/api/like-ranking.js', import.meta.url), 'utf8');
const middleware = readFileSync(new URL('../functions/api/_middleware.js', import.meta.url), 'utf8');

test('history removes the current tab and keeps every archive mode', () => {
  for (const mode of ['daily', 'weekly', 'monthly', 'ranking', 'tracks', 'broadcasts']) {
    assert.match(historyPage, new RegExp(`data-mode="${mode}"`));
  }
  assert.doesNotMatch(historyPage, /data-mode="current"/);
  assert.doesNotMatch(likesPage, /#current|>現在<\/a>/);
  assert.match(historyPage, /href="\/history\/likes\/">いいね<\/a>/);
  assert.equal((historyPage.match(/<link rel="stylesheet"/g) || []).length, 1);
  assert.equal((historyPage.match(/<script /g) || []).length, 1);
});

test('monthly tab appears before leaderboard on both history pages', () => {
  assert.ok(historyPage.indexOf('data-mode="monthly"') < historyPage.indexOf('data-mode="ranking"'));
  assert.ok(likesPage.indexOf('/history/#monthly') < likesPage.indexOf('/history/#ranking'));
});

test('history defaults invalid and retired hashes to weekly', () => {
  assert.match(historyPage, /data-mode="weekly" class="active"/);
  assert.match(historyEntry, /const VALID_MODES = new Set\(\['daily', 'weekly', 'ranking', 'monthly', 'tracks', 'broadcasts'\]\)/);
  assert.match(historyEntry, /history\.replaceState\(null, '', '#weekly'\)/);
  assert.match(historyEntry, /import\('\/history\/history-lite\.js'\)/);
  assert.doesNotMatch(historyEntry, /dashboard-history|audienceChart|loadAudience/);
});

test('history tabs use a fixed two-row grid without horizontal scrolling', () => {
  assert.match(historyStyles, /\.mode-tabs \{[^}]*display:\s*grid/);
  assert.match(historyStyles, /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(historyStyles, /\.mode-tabs \{[^}]*overflow:\s*hidden/);
  assert.match(historyStyles, /\.mode-tabs button, \.mode-tabs a \{[^}]*white-space:\s*normal/);
  assert.doesNotMatch(historyStyles, /\.mode-tabs \{[^}]*overflow-x:\s*auto/);
});

test('history removes the explanatory panel below the tabs', () => {
  assert.doesNotMatch(historyPage, /<section id="guide"/);
  assert.match(historyPage, /<div id="guide" hidden aria-hidden="true">/);
  assert.doesNotMatch(historyPage, /現在のデータ|ミニットファクトの直近1440件/);
});

test('history restores one visible chart canvas and leaves 24-hour charts on the main page only', () => {
  assert.match(historyPage, /<canvas id="chart"[^>]*><\/canvas>/);
  assert.doesNotMatch(historyPage, /audienceChart|オンライン・コメント勢い（24時間）/);
  assert.doesNotMatch(historyPage, /id="chart"[^>]*hidden/);
  assert.match(historyStyles, /\.chart-panel \{[^}]*margin-top/);
  assert.doesNotMatch(historyStyles, /\.chart-panel \{[^}]*content-visibility/);
  assert.match(historyStyles, /\.data-panel \{[^}]*content-visibility:\s*auto/);
  assert.match(historyClient, /requestAnimationFrame\(drawChart\)/);
  assert.match(historyClient, /function drawSummaryChart/);
  assert.match(historyClient, /function drawBroadcastChart/);
});

test('track history defaults to yesterday as a single day', () => {
  assert.match(historyPage, /id="trackWeekMode" type="checkbox" checked/);
  assert.match(historyEntry, /trackDate\.value = yesterday/);
  assert.match(historyEntry, /trackWeekMode\.checked = false/);
  assert.match(historyClient, /if \(el\('trackWeekMode'\)\.checked\)/);
  assert.match(historyClient, /el\('from'\)\.value = el\('trackDate'\)\.value/);
  assert.match(historyClient, /el\('to'\)\.value = el\('trackDate'\)\.value/);
});

test('history visual tokens and panel sizing match the main dashboard', () => {
  for (const declaration of [
    '--bg: #f6f8fb',
    '--panel: #ffffff',
    '--panel-2: #f1f4f8',
    '--line: #d9e1eb',
    '--text: #172033',
    '--muted: #667287',
    '--accent: #d93f79',
    '--comment: #168b73',
    '--radius: 20px',
  ]) {
    assert.match(mainStyles, new RegExp(declaration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(historyStyles, new RegExp(declaration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(historyStyles, /\.top-card \{[^}]*padding:\s*20px/);
  assert.match(historyStyles, /\.button \{[^}]*min-height:\s*44px/);
  assert.match(historyStyles, /\.chart-panel \{[^}]*padding:\s*18px/);
  assert.match(historyStyles, /\.data-panel \{[^}]*padding:\s*18px/);
  assert.match(historyStyles, /\.summary-cards article \{[^}]*padding:\s*17px/);
});

test('history client preserves summary, ranking, tracks and broadcast endpoints', () => {
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
  assert.match(historyClient, /ttl:\s*5 \* 60_000/);
  assert.match(historyClient, /ttl:\s*10 \* 60_000/);
  assert.doesNotMatch(historyClient, /cache:\s*['"]no-store['"]/);
  assert.doesNotMatch(historyClient, /searchParams\.set\(['"]v/);
});

test('history tables render newest summary rows first and paginate only in the browser', () => {
  assert.match(historyClient, /return \[\.\.\.rows\]\.reverse\(\)/);
  assert.match(historyClient, /const PAGE_SIZE = 200/);
  assert.match(historyClient, /state\.visibleRows \+= PAGE_SIZE/);
  assert.match(historyClient, /exportCsv/);
});

test('likes tab filters to Sakurazaka artists or JP-prefixed ISRC tracks', () => {
  assert.match(likesPage, /aria-current="page" href="\/history\/likes\/">いいね<\/a>/);
  assert.match(likesPage, /最新いいね/);
  assert.match(likesPage, /今週再生/);
  assert.match(likesClient, /\/api\/like-ranking\?limit=500/);
  assert.match(likesClient, /\/api\/track-history\?/);
  assert.match(likeApi, /artist,''\)\) LIKE '櫻坂%'/);
  assert.match(likeApi, /isrc,''\)\)\) LIKE 'JP%'/);
  assert.match(likeApi, /artist_starts_sakurazaka_or_isrc_starts_jp/);
});

test('edge middleware shares track-history and like-ranking D1 reads', () => {
  assert.match(middleware, /url\.pathname === '\/api\/track-history'/);
  assert.match(middleware, /url\.pathname === '\/api\/like-ranking'/);
  assert.match(middleware, /ttl: 900, browser: 300/);
});
