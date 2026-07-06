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
  const source = await text('public/app.js');
  assert.match(source, /fetch\(['"]\/api\/dashboard['"]/);
  assert.match(source, /AbortController/);
  assert.match(source, /refreshInFlight/);
  assert.match(source, /escapeText/);
  assert.match(source, /if \(!document\.hidden\) refresh\(\)/);
  assert.match(source, /前回表示・前回グラフをそのまま維持/);
});

test('dashboard fetch cache preserves the last goal prediction on delta payloads', async () => {
  const source = await text('public/dashboard-fetch-cache.js');
  assert.match(source, /function mergeGoalPrediction/);
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

test('Pages configuration binds the expected D1 database and output directory', async () => {
  const config = JSON.parse((await text('wrangler.jsonc')).replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(config.name, 'skrzk');
  assert.equal(config.pages_build_output_dir, './public');
  assert.equal(config.d1_databases?.[0]?.binding, 'DB');
  assert.equal(config.d1_databases?.[0]?.database_name, 'stationhead-monitor');
  assert.equal(config.d1_databases?.[0]?.migrations_dir, '../database/migrations');
});
