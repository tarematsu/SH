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
  assert.match(html, /id="channelFallback"/);
  assert.match(html, /id="trackFallback"/);
  assert.match(html, /id="updated"/);
  assert.match(html, /id="online"/);
  assert.match(html, /id="members"/);
  assert.match(html, /id="totalStreams"/);
  assert.match(html, /id="membersYesterdayDelta"/);
  assert.match(html, /id="membersDayBeforeDelta"/);
  assert.match(html, /id="streamsYesterdayDelta"/);
  assert.match(html, /id="streamsDayBeforeDelta"/);
  assert.match(html, /id="nowPlayingLink"/);
  assert.match(html, /id="queue"/);
  assert.match(html, /id="streamCount"/);
  assert.match(html, /id="goalMilestones"/);
  assert.match(html, /id="audienceChart"/);
  assert.match(html, /href="\/history\/"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('dashboard removes the external web button and playback trend', async () => {
  const html = await text('public/index.html');
  const shell = await text('public/app-main.js');
  assert.doesNotMatch(html, />Webで開く</);
  assert.doesNotMatch(html, /stream-key/);
  assert.doesNotMatch(html, /オンライン・再生数・コメント勢い/);
  assert.match(html, /オンライン・コメント勢い/);
  assert.match(shell, /online_member_count/);
  assert.match(shell, /comment_velocity/);
  assert.doesNotMatch(shell, /current_stream_count/);
  assert.doesNotMatch(shell, /再生数/);
});

test('dashboard displays total streams and two completed UTC-day changes', async () => {
  const html = await text('public/index.html');
  const source = await text('public/dashboard-metrics.js');
  const endpoint = await text('functions/api/dashboard-daily-changes.js');
  assert.match(html, />総メンバー数</);
  assert.match(html, />総再生数</);
  assert.doesNotMatch(html, /ユニーク参加者|延べ参加者|totalListens|listensDelta/);
  assert.match(source, /current_stream_count/);
  assert.match(source, /\/api\/dashboard-daily-changes/);
  assert.match(source, /member_growth/);
  assert.match(source, /stream_growth/);
  assert.match(source, /'昨日'/);
  assert.match(source, /'一昨日'/);
  assert.match(endpoint, /reported_current_stream_count/);
  assert.match(endpoint, /sh_total_member_daily/);
  assert.match(endpoint, /Math\.floor\(now \/ DAY_MS\) \* DAY_MS/);
  assert.doesNotMatch(`${source}\n${endpoint}`, /total_listens/);
});

test('dashboard declares and implements a light white-base theme', async () => {
  const html = await text('public/index.html');
  const css = await text('public/app-lite.css');
  assert.match(html, /name="theme-color" content="#f6f8fb"/);
  assert.match(html, /name="color-scheme" content="light"/);
  assert.match(css, /color-scheme:\s*light/);
  assert.match(css, /--bg:\s*#f6f8fb/);
  assert.match(css, /--panel:\s*#ffffff/);
  assert.match(css, /body \{[^}]*background:/);
  assert.match(css, /#audienceChart \{[^}]*background:\s*#fff/);
});

test('mobile dashboard keeps one stylesheet and one entry script', async () => {
  const html = await text('public/index.html');
  const entry = await text('public/dashboard-metrics.js');
  assert.match(html, /\/app-lite\.css/);
  assert.match(html, /type="module" src="\/dashboard-metrics\.js"/);
  assert.equal((html.match(/<link rel="stylesheet"/g) || []).length, 1);
  assert.equal((html.match(/<script /g) || []).length, 1);
  assert.match(entry, /import\('\/app-main\.js'\)/);
  assert.doesNotMatch(html, /\/dashboard-optimized\.js/);
  assert.doesNotMatch(html, /\/app-state\.js/);
  assert.doesNotMatch(html, /\/design-system\.css/);
});

test('dashboard mobile layout prevents metric and goal number clipping', async () => {
  const css = await text('public/app-lite.css');
  assert.match(css, /\.metric\.featured \{ grid-column: 1 \/ -1/);
  assert.match(css, /\.metric strong \{[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.goal-number \{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.top-actions \{[^}]*repeat\(2/);
  assert.match(css, /scrollbar-gutter:\s*stable/);
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

test('dashboard shell reuses the existing requests and fixes broken-image states', async () => {
  const source = await text('public/app-main.js');
  assert.match(source, /window\.fetch = async/);
  assert.match(source, /\/api\/dashboard-history/);
  assert.match(source, /setupStaticImage\('channelImage', 'channelFallback'\)/);
  assert.match(source, /setupStaticImage\('trackImage', 'trackFallback'\)/);
  assert.match(source, /MutationObserver/);
  assert.match(source, /queue-thumb/);
  assert.match(source, /rgba\(31,45,68,\.11\)/);
  assert.match(source, /const tickCount = width < 480 \? 4 : 6/);
});

test('dashboard client preserves playback, queue expansion and goals', async () => {
  const source = await text('public/app-lite.js');
  assert.match(source, /function playbackView/);
  assert.match(source, /\/api\/dashboard-queue\?offset=/);
  assert.match(source, /goal_predictions/);
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
