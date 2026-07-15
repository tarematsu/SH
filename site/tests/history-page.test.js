import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const historyPage = readFileSync(new URL('../public/history/index.html', import.meta.url), 'utf8');
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
  assert.match(historyPage, /\/history\/history-lite\.css/);
  assert.match(historyPage, /\/history\/history-lite\.js/);
  assert.doesNotMatch(historyPage, /history-copy-fixes\.js/);
});

test('history page uses the same white mobile-first visual system as the dashboard', () => {
  assert.match(historyPage, /name="theme-color" content="#f6f8fb"/);
  assert.match(historyPage, /name="color-scheme" content="light"/);
  assert.match(historyStyles, /color-scheme:\s*light/);
  assert.match(historyStyles, /--bg:\s*#f6f8fb/);
  assert.match(historyStyles, /--panel:\s*#ffffff/);
  assert.match(historyStyles, /@media \(max-width: 760px\)/);
  assert.match(historyStyles, /\.mode-tabs button, \.mode-tabs a/);
  assert.match(historyStyles, /\.like-ranking/);
  assert.match(historyStyles, /overflow-x:\s*auto/);
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

test('likes tab ranks like and bite counters with cached fixed URLs', () => {
  assert.match(likesPage, /aria-current="page" href="\/history\/likes\/">いいね<\/a>/);
  assert.match(likesPage, /like \/ bite/);
  assert.equal((likesPage.match(/<link rel="stylesheet"/g) || []).length, 1);
  assert.equal((likesPage.match(/<script /g) || []).length, 1);
  assert.match(likesClient, /\/api\/like-ranking\?/);
  assert.match(likesClient, /sessionStorage\.getItem/);
  assert.match(likesClient, /sessionStorage\.setItem/);
  assert.match(likesClient, /total_like_count/);
  assert.match(likesClient, /peak_like_count/);
  assert.match(likesClient, /average_like_count/);
  assert.doesNotMatch(likesClient, /cache:\s*['"]no-store['"]/);
});

test('edge middleware shares current, track-history and like-ranking D1 reads', () => {
  assert.match(middleware, /url\.pathname === '\/api\/history-current'/);
  assert.match(middleware, /ttl: 60, browser: 30/);
  assert.match(middleware, /url\.pathname === '\/api\/track-history'/);
  assert.match(middleware, /url\.pathname === '\/api\/like-ranking'/);
  assert.match(middleware, /ttl: 900, browser: 300/);
});
