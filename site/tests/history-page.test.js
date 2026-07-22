import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const historyPage = readFileSync(new URL('../public/history/index.html', import.meta.url), 'utf8');
const historyEntry = readFileSync(new URL('../public/history/history-main.js', import.meta.url), 'utf8');
const historyClient = readFileSync(new URL('../public/history/history-lite.js', import.meta.url), 'utf8');
const historyFixes = readFileSync(new URL('../public/history/history-page-fixes.js', import.meta.url), 'utf8');
const historyStyles = readFileSync(new URL('../public/history/history-lite.css', import.meta.url), 'utf8');
const mainStyles = readFileSync(new URL('../public/app-lite.css', import.meta.url), 'utf8');
const likesPage = readFileSync(new URL('../public/history/likes/index.html', import.meta.url), 'utf8');
const likesClient = readFileSync(new URL('../public/history/history-likes.js', import.meta.url), 'utf8');
const broadcastClient = readFileSync(new URL('../public/history/history-broadcasts.js', import.meta.url), 'utf8');
const trackHistoryApi = readFileSync(new URL('../functions/api/track-history.js', import.meta.url), 'utf8');
const rankingLibrary = readFileSync(new URL('../functions/lib/track-ranking.js', import.meta.url), 'utf8');
const sakurazakaApi = readFileSync(new URL('../functions/api/sakurazaka46jp.js', import.meta.url), 'utf8');
const middleware = readFileSync(new URL('../functions/_middleware.js', import.meta.url), 'utf8');

const ARCHIVE_MODES = ['daily', 'weekly', 'monthly', 'ranking', 'tracks', 'broadcasts'];

test('history exposes the six canonical archive modes', () => {
  for (const mode of ARCHIVE_MODES) {
    assert.match(historyPage, new RegExp(`data-mode="${mode}"`));
  }
  assert.match(historyPage, /href="\/history\/likes\/">いいね<\/a>/);
  assert.equal((historyPage.match(/<link rel="stylesheet"/g) || []).length, 1);
  assert.equal((historyPage.match(/<script /g) || []).length, 1);
});

test('monthly tab appears before leaderboard on both history pages', () => {
  assert.ok(historyPage.indexOf('data-mode="monthly"') < historyPage.indexOf('data-mode="ranking"'));
  assert.ok(likesPage.indexOf('/history/#monthly') < likesPage.indexOf('/history/#ranking'));
});

test('history defaults invalid hashes to weekly and loads one canonical client', () => {
  assert.match(historyPage, /data-mode="weekly" class="active"/);
  assert.match(historyEntry, /const VALID_MODES = new Set\(\['daily', 'weekly', 'ranking', 'monthly', 'tracks', 'broadcasts'\]\)/);
  assert.match(historyEntry, /history\.replaceState\(null, '', '#weekly'\)/);
  assert.match(historyEntry, /import\('\/history\/history-lite\.js'\)/);
  assert.match(historyClient, /const MODES = Object\.freeze/);
  for (const mode of ARCHIVE_MODES) assert.match(historyClient, new RegExp(`${mode}: \\{`));
});

test('history tabs use a fixed two-row grid without horizontal scrolling', () => {
  assert.match(historyStyles, /\.mode-tabs \{[^}]*display:\s*grid/);
  assert.match(historyStyles, /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(historyStyles, /\.mode-tabs \{[^}]*overflow:\s*hidden/);
  assert.match(historyStyles, /\.mode-tabs button, \.mode-tabs a \{[^}]*white-space:\s*normal/);
});

test('history keeps the guide as an accessible hidden label source', () => {
  assert.match(historyPage, /<div id="guide" hidden aria-hidden="true">/);
  assert.match(historyClient, /setText\('guideTitle', config\.title\)/);
  assert.match(historyClient, /setText\('tableTitle', config\.table\)/);
});

test('history keeps one visible chart and delegates official series rendering', () => {
  assert.match(historyPage, /<canvas id="chart"[^>]*><\/canvas>/);
  assert.match(historyStyles, /\.chart-panel \{[^}]*margin-top/);
  assert.match(historyStyles, /\.data-panel \{[^}]*content-visibility:\s*auto/);
  assert.match(historyClient, /function drawSummaryChart/);
  assert.match(historyClient, /import\('\/history\/history-broadcasts\.js'\)/);
  assert.match(broadcastClient, /function draw\(\)/);
});

test('track history defaults to yesterday as a single day', () => {
  assert.match(historyPage, /id="trackWeekMode" type="checkbox" checked/);
  assert.match(historyEntry, /trackDate\.value = yesterday/);
  assert.match(historyEntry, /trackWeekMode\.checked = false/);
  assert.match(historyClient, /if \(el\('trackWeekMode'\)\.checked\)/);
  assert.match(historyClient, /el\('from'\)\.value = mondayOf/);
  assert.match(historyClient, /el\('to'\)\.value = sundayOf/);
});

test('track ranking observer scopes itself to generated table nodes', () => {
  assert.match(
    historyFixes,
    /\[document\.getElementById\('thead'\), document\.getElementById\('tbody'\)\]/,
  );
  assert.match(historyFixes, /observer\.observe\(target, \{ childList: true, subtree: true \}\)/);
  assert.match(historyFixes, /let trackRankingRenderQueued = false/);
  assert.match(historyFixes, /if \(trackRankingRenderQueued\) return/);
  assert.match(historyFixes, /window\.addEventListener\('hashchange', scheduleTrackRanking\)/);
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
    const pattern = new RegExp(declaration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    assert.match(mainStyles, pattern);
    assert.match(historyStyles, pattern);
  }
  assert.match(historyStyles, /\.top-card \{[^}]*padding:\s*20px/);
  assert.match(historyStyles, /\.button \{[^}]*min-height:\s*44px/);
  assert.match(historyStyles, /\.chart-panel \{[^}]*padding:\s*18px/);
  assert.match(historyStyles, /\.data-panel \{[^}]*padding:\s*18px/);
});

test('history client uses the canonical history and track-history endpoints', () => {
  assert.match(historyClient, /\/api\/history\?/);
  assert.match(historyClient, /\/api\/track-history\?latest=1/);
  assert.match(historyClient, /\/api\/track-history\?\$\{/);
  assert.match(historyClient, /weekly_metrics/);
  assert.match(historyClient, /like_count/);
  assert.match(broadcastClient, /\/api\/sakurazaka46jp\?/);
});

test('history client reduces repeated reads with browser session caching', () => {
  assert.match(historyClient, /sessionStorage\.getItem/);
  assert.match(historyClient, /sessionStorage\.setItem/);
  assert.match(historyClient, /5 \* 60_000/);
  assert.match(historyClient, /10 \* 60_000/);
});

test('history tables render newest rows first and paginate only in the browser', () => {
  assert.match(historyClient, /return \[\.\.\.rows\]\.reverse\(\)/);
  assert.match(historyClient, /const PAGE_SIZE = 200/);
  assert.match(historyClient, /state\.visibleRows \+= PAGE_SIZE/);
  assert.match(historyClient, /function exportCsv/);
});

test('likes page reads integrated ranking and weekly plays from one track-history response', () => {
  assert.match(likesPage, /aria-current="page" href="\/history\/likes\/">いいね<\/a>/);
  assert.match(likesPage, /最新いいね/);
  assert.match(likesPage, /今週再生/);
  assert.match(likesClient, /\/api\/track-history\?/);
  assert.match(likesClient, /result\.data\.ranking/);
  assert.match(likesClient, /result\.data\.ranking_summary/);
  assert.match(trackHistoryApi, /ranking_summary/);
  assert.match(trackHistoryApi, /ranking_scope/);
  assert.match(rankingLibrary, /FROM sh_track_counter_current/);
  assert.match(rankingLibrary, /LIKE '櫻坂%'/);
});

test('Sakurazaka endpoint and comparison client share one canonical name', () => {
  assert.match(sakurazakaApi, /subject: 'sakurazaka46jp'/);
  assert.match(sakurazakaApi, /cachedSakurazakaSeries/);
  assert.match(broadcastClient, /sakurazaka46jp:v1:/);
  assert.match(broadcastClient, /\/api\/sakurazaka46jp\?/);
});

test('edge middleware shares canonical materialized track-history reads', () => {
  assert.match(middleware, /MATERIALIZED_API_VARIANTS/);
  assert.match(middleware, /SERVICE_MATERIALIZED_MODEL_KEYS/);
  assert.match(middleware, /cache\.put/);
  assert.match(middleware, /materializedApiKey/);
});
