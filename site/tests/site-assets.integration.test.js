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

  assert.ok(references.length >= 3, 'the dashboard should reference its CSS, JavaScript and history page');
  for (const reference of new Set(references)) {
    await assert.doesNotReject(
      access(path.join(publicRoot, reference.replace(/^\//, ''))),
      `missing dashboard asset: ${reference}`,
    );
  }
});

test('dashboard HTML keeps accessibility, privacy and all public sections', async () => {
  const html = await text('public/index.html');
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /noindex,nofollow/);
  assert.match(html, /id="channelName"/);
  assert.match(html, /id="updated"/);
  assert.match(html, /id="online"/);
  assert.match(html, /id="members"/);
  assert.match(html, /id="totalListens"/);
  assert.match(html, /id="nowPlayingLink"/);
  assert.match(html, /id="queue"/);
  assert.match(html, /id="streamCount"/);
  assert.match(html, /id="goalMilestones"/);
  assert.match(html, /id="chart"/);
  assert.match(html, /\/history\/index\.html/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('dashboard declares and implements a light white-base theme', async () => {
  const html = await text('public/index.html');
  const css = await text('public/app-lite.css');
  assert.match(html, /name="theme-color" content="#f6f8fb"/);
  assert.match(html, /name="color-scheme" content="light"/);
  assert.match(css, /color-scheme:\s*light/);
  assert.match(css, /--bg:\s*#f6f8fb/);
  assert.match(css, /--panel:\s*#ffffff/);
  assert.match(css, /body \{[^}]*background:\s*var\(--bg\)/);
  assert.match(css, /#chart \{[^}]*background-color:\s*#fff/);
});

test('mobile dashboard uses one stylesheet and one script', async () => {
  const html = await text('public/index.html');
  assert.match(html, /\/app-lite\.css/);
  assert.match(html, /\/app-lite\.js/);
  assert.equal((html.match(/<link rel="stylesheet"/g) || []).length, 1);
  assert.equal((html.match(/<script /g) || []).length, 1);
  assert.doesNotMatch(html, /\/dashboard-optimized\.js/);
  assert.doesNotMatch(html, /\/app-state\.js/);
  assert.doesNotMatch(html, /\/design-system\.css/);
});

test('dashboard client uses shared cache keys and avoids per-viewer D1 history deltas', async () => {
  const source = await text('public/app-lite.js');
  assert.match(source, /const DASHBOARD_URL = '\/api\/dashboard\?history=0'/);
  assert.match(source, /const HISTORY_URL = '\/api\/dashboard-history'/);
  assert.doesNotMatch(source, /searchParams\.set\(['"]since/);
  assert.doesNotMatch(source, /searchParams\.set\(['"]queue_revision/);
  assert.match(source, /mergeLatestIntoHistory/);
  assert.match(source, /localStorage\.setItem/);
  assert.match(source, /document\.hidden/);
  assert.match(source, /AbortController/);
  assert.match(source, /60_000/);
});

test('dashboard client preserves playback, queue expansion, goals and chart details', async () => {
  const source = await text('public/app-lite.js');
  assert.match(source, /function playbackView/);
  assert.match(source, /\/api\/dashboard-queue\?offset=/);
  assert.match(source, /goal_predictions/);
  assert.match(source, /comment_velocity/);
  assert.match(source, /function selectChartPoint/);
  assert.match(source, /function spotifyUrl/);
});

test('edge middleware shares initial dashboard history between viewers', async () => {
  const source = await text('functions/api/_middleware.js');
  assert.match(source, /url\.pathname === '\/api\/dashboard-history'/);
  assert.match(source, /ttl: 300, browser: 60/);
  assert.match(source, /cache\.match/);
  assert.match(source, /cache\.put/);
  assert.match(source, /inFlight/);
});

test('Pages configuration binds the expected D1 database and output directory', async () => {
  const config = JSON.parse((await text('wrangler.jsonc')).replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(config.name, 'skrzk');
  assert.equal(config.pages_build_output_dir, './public');
  assert.equal(config.d1_databases?.[0]?.binding, 'DB');
  assert.equal(config.d1_databases?.[0]?.database_name, 'stationhead-buddies');
  assert.equal(config.d1_databases?.[0]?.database_id, 'f361aae0-05f0-42bc-8784-77100e80133d');
});
