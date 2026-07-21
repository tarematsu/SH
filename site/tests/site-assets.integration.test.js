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
  for (const id of [
    'channelName', 'channelFallback', 'trackFallback', 'updated', 'online', 'members',
    'totalStreams', 'membersYesterdayDelta', 'membersDayBeforeDelta',
    'streamsYesterdayDelta', 'streamsDayBeforeDelta', 'nowPlayingLink', 'queue',
    'streamCount', 'goalMilestones', 'audienceChart',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /href="\/history\/"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('dashboard renders audience and comment velocity from one response', async () => {
  const html = await text('public/index.html');
  const client = await text('public/dashboard-client.js');
  assert.match(html, /オンライン・コメント勢い/);
  assert.match(client, /const DASHBOARD_URL = '\/api\/dashboard'/);
  assert.match(client, /payload\.history/);
  assert.match(client, /payload\.queue/);
  assert.match(client, /online_member_count/);
  assert.match(client, /comment_velocity/);
});

test('dashboard displays total streams and completed UTC-day changes', async () => {
  const html = await text('public/index.html');
  const source = await text('public/dashboard-metrics.js');
  const endpoint = await text('functions/api/dashboard-daily-changes.js');
  assert.match(html, />総メンバー数</);
  assert.match(html, />総再生数</);
  assert.match(source, /current_stream_count/);
  assert.match(source, /\/api\/dashboard-daily-changes/);
  assert.match(source, /member_growth/);
  assert.match(source, /stream_growth/);
  assert.match(endpoint, /reported_current_stream_count/);
  assert.match(endpoint, /sh_total_member_daily/);
});

test('dashboard declares and implements a light white-base theme', async () => {
  const html = await text('public/index.html');
  const css = await text('public/app-lite.css');
  assert.match(html, /name="theme-color" content="#f6f8fb"/);
  assert.match(html, /name="color-scheme" content="light"/);
  assert.match(css, /color-scheme:\s*light/);
  assert.match(css, /--bg:\s*#f6f8fb/);
  assert.match(css, /--panel:\s*#ffffff/);
  assert.match(css, /#audienceChart \{[^}]*background:\s*#fff/);
});

test('mobile dashboard keeps one stylesheet and one entry script', async () => {
  const html = await text('public/index.html');
  const entry = await text('public/dashboard-metrics.js');
  assert.match(html, /\/app-lite\.css/);
  assert.match(html, /type="module" src="\/dashboard-metrics\.js"/);
  assert.equal((html.match(/<link rel="stylesheet"/g) || []).length, 1);
  assert.equal((html.match(/<script /g) || []).length, 1);
  assert.match(entry, /import\('\/dashboard-client\.js'\)/);
});

test('dashboard mobile layout prevents metric and goal number clipping', async () => {
  const css = await text('public/app-lite.css');
  assert.match(css, /\.metric\.featured \{ grid-column: 1 \/ -1/);
  assert.match(css, /\.metric strong \{[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.goal-number \{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.top-actions \{[^}]*repeat\(2/);
});

test('dashboard client uses one shared cache and one canonical fetch', async () => {
  const source = await text('public/dashboard-client.js');
  assert.equal((source.match(/\/api\/dashboard/g) || []).length, 1);
  assert.match(source, /localStorage\.setItem/);
  assert.match(source, /document\.hidden/);
  assert.match(source, /AbortController/);
  assert.match(source, /60_000/);
});

test('dashboard client renders the complete fetched queue', async () => {
  const source = await text('public/dashboard-client.js');
  assert.match(source, /function playbackView/);
  assert.match(source, /queue_status/);
  assert.match(source, /function spotifyUrl/);
  assert.match(source, /state\.queue\.slice/);

  const endpoint = await text('functions/api/dashboard.js');
  assert.match(endpoint, /const enrichedQueue = queue\.map/);
  assert.match(endpoint, /queue_status/);
});

test('edge middleware serves materialized canonical responses', async () => {
  const source = await text('functions/_middleware.js');
  assert.match(source, /MATERIALIZED_API_VARIANTS/);
  assert.match(source, /materializedApiKey/);
  assert.match(source, /cache\.match/);
  assert.match(source, /cache\.put/);
});

test('Pages configuration binds the expected D1 database and output directory', async () => {
  const config = JSON.parse((await text('wrangler.jsonc')).replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(config.name, 'skrzk');
  assert.equal(config.pages_build_output_dir, './public');
  assert.equal(config.d1_databases?.[0]?.binding, 'DB');
  assert.equal(config.d1_databases?.[0]?.database_name, 'stationhead-buddies');
});

test('Pages homepage is never stored by browsers or shared caches', async () => {
  const headers = await text('public/_headers');
  assert.match(headers, /\/\r?\n\s+Cache-Control: no-store, max-age=0, must-revalidate/m);
  assert.match(headers, /\/index\.html\r?\n\s+Cache-Control: no-store, max-age=0, must-revalidate/m);
});
