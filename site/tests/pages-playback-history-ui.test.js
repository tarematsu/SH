import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const mainPage = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const biteClient = readFileSync(new URL('../public/dashboard-bites.js', import.meta.url), 'utf8');
const historyEntry = readFileSync(new URL('../public/history/history-main.js', import.meta.url), 'utf8');
const historyFixes = readFileSync(new URL('../public/history/history-page-fixes.js', import.meta.url), 'utf8');
const trackEndpoint = readFileSync(new URL('../functions/api/track-history.js', import.meta.url), 'utf8');

test('main page renders the current track bite count from the existing dashboard response', () => {
  assert.match(mainPage, /id="trackBites" hidden/);
  assert.ok(mainPage.indexOf('/dashboard-bites.js') < mainPage.indexOf('/dashboard-metrics.js'));
  assert.match(biteClient, /url\.pathname !== '\/api\/dashboard'/);
  assert.match(biteClient, /current\?\.bite_count/);
  assert.match(biteClient, /`♡ \$\{integer\.format\(count\)\}`/);
  assert.doesNotMatch(biteClient, /fetch\(['"]\/api\/playback/);
});

test('track history uses the database that owns queue snapshots', () => {
  assert.match(trackEndpoint, /MINUTE_DB:\s*null/);
  assert.match(trackEndpoint, /handleTrackHistory/);
});

test('track history is presented as an ordered like-count ranking', () => {
  assert.match(historyEntry, /import\('\/history\/history-page-fixes\.js'\)/);
  assert.match(historyFixes, /labels\.indexOf\('いいね数'\)/);
  assert.match(historyFixes, /rows\.sort/);
  assert.match(historyFixes, /再生曲 いいね数ランキング/);
  assert.match(historyFixes, /daily-total-row/);
});

test('sparse daily summaries draw visible point markers instead of an empty canvas', () => {
  assert.match(historyFixes, /location\.hash !== '#daily'/);
  assert.match(historyFixes, /state\.lines > 0/);
  assert.match(historyFixes, /this\.arc\(x, y, 3/);
});
