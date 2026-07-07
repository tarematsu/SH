import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(siteRoot, 'public');

async function text(relativePath) {
  return readFile(path.join(siteRoot, relativePath), 'utf8');
}

test('main page references only existing local static assets', async () => {
  const html = await text('public/index.html');
  const references = [...html.matchAll(/(?:href|src)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value) => value.startsWith('/') && !value.startsWith('//'))
    .map((value) => value.split(/[?#]/, 1)[0])
    .filter(Boolean);

  assert.ok(references.length >= 4, 'the dashboard should reference its CSS and JavaScript assets');
  for (const reference of new Set(references)) {
    await assert.doesNotReject(
      access(path.join(publicRoot, reference.replace(/^\//, ''))),
      `missing dashboard asset: ${reference}`,
    );
  }
});

test('dashboard HTML keeps accessibility, privacy and live-state anchors', async () => {
  const html = await text('public/index.html');
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /noindex,nofollow/);
  assert.match(html, /id="channelName"/);
  assert.match(html, /id="updated"/);
  assert.match(html, /rel="noopener"/);
});

test('browser application remains wired to the dashboard API and resilient refresh flow', async () => {
  const html = await text('public/index.html');
  const appState = await text('public/app-state.js');
  const appPlayback = await text('public/app-playback.js');
  const app = await text('public/app.js');
  assert.match(html, /\/app-state\.js/);
  assert.match(html, /\/app-playback\.js/);
  assert.match(html, /\/app\.js/);
  assert.ok(
    html.indexOf('/app-state.js') < html.indexOf('/app-playback.js')
      && html.indexOf('/app-playback.js') < html.indexOf('/app.js'),
    'split app modules must load before the refresh entrypoint',
  );
  assert.match(app, /fetch\(['"]\/api\/dashboard['"]/);
  assert.match(app, /AbortController/);
  assert.match(app, /refreshInFlight/);
  assert.match(appState, /escapeText/);
  assert.match(appPlayback, /renderNowDisplay/);
  assert.match(app, /if \(!document\.hidden\) refresh\(\)/);
});

test('dashboard display guards preserve ETA and expose comment velocity to chart overlays', async () => {
  const html = await text('public/index.html');
  const source = await text('public/dashboard-display-guards.js');
  assert.match(html, /\/dashboard-display-guards\.js/);
  assert.ok(
    html.indexOf('/dashboard-display-guards.js') < html.indexOf('/comment-velocity-chart.js'),
    'display guards must run before the comment velocity chart wrapper',
  );
  assert.match(source, /lastGoalPrediction/);
  assert.match(source, /commentVelocityValues/);
  assert.match(source, /commentVelocityMax/);
});

test('dashboard fetch cache does not request queue-unchanged deltas without a local queue', async () => {
  const source = await text('public/dashboard-fetch-cache.js');
  assert.match(source, /function hasUsableQueue/);
  assert.match(source, /if \(state\.queueRevision && hasUsableQueue\(\)\)/);
  assert.match(source, /payload\.queue_unchanged = false/);
});

test('dashboard fetch cache preserves a compatible last goal prediction on delta payloads', async () => {
  const source = await text('public/dashboard-fetch-cache.js');
  assert.match(source, /function mergeGoalPrediction/);
  assert.match(source, /function sameGoal/);
  assert.match(source, /function alreadyReachedGoal/);
  assert.match(source, /state\.lastPayload\?\.goal_prediction/);
  assert.match(source, /payload\.goal_prediction = structuredClone\(previous\)/);
});

test('standalone Stationhead API test has no rewrite that can create a canonical redirect loop', async () => {
  const directoryHtml = await text('public/stationhead-api-test/index.html');
  const rootHtml = await text('public/stationhead-api-test.html');
  const redirects = await text('public/_redirects');

  for (const html of [directoryHtml, rootHtml]) {
    assert.match(html, /Stationhead Weekly Leaderboard API 通信テスト/);
    assert.match(html, /\/api\/stationhead-weekly-leaderboard-test/);
    assert.match(html, /noindex,nofollow,noarchive/);
  }
  assert.doesNotMatch(redirects, /^\/stationhead-api-test\/?\s+/m);
});
