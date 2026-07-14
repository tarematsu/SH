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
  assert.match(app, /fetch\(['"]\/api\/dashboard\?history=0['"]/);
  assert.match(app, /\/api\/dashboard-history/);
  assert.match(app, /AbortController/);
  assert.match(app, /refreshInFlight/);
  assert.match(app, /Number\.isFinite\(countValue\)/);
  assert.match(app, /goal && count != null/);
  assert.match(appState, /escapeText/);
  assert.match(appPlayback, /renderNowDisplay/);
  assert.match(app, /if \(!document\.hidden\) refresh\(\)/);
});

test('dashboard chart renderer preserves ETA and comment velocity overlays', async () => {
  const html = await text('public/index.html');
  const app = await text('public/app.js');
  const guards = await text('public/dashboard-display-guards.js');
  const chart = await text('public/app-chart.js');
  assert.match(html, /\/dashboard-display-guards\.js/);
  assert.doesNotMatch(html, /\/comment-velocity-chart\.js/);
  assert.match(guards, /lastGoalPrediction/);
  assert.match(chart, /commentVelocityValues/);
  assert.match(chart, /commentVelocityMax/);
  assert.match(chart, /drawCommentVelocityBars/);
  assert.match(html, /id="goalMilestones"/);
  assert.match(app, /data\.goal_predictions/);
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


test('Pages configuration binds the expected D1 database and output directory', async () => {
  const config = JSON.parse((await text('wrangler.jsonc')).replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(config.name, 'skrzk');
  assert.equal(config.pages_build_output_dir, './public');
  assert.equal(config.d1_databases?.[0]?.binding, 'DB');
  assert.equal(config.d1_databases?.[0]?.database_name, 'stationhead-legacy');
  assert.equal(config.d1_databases?.[0]?.migrations_dir, '../database/migrations');
});
