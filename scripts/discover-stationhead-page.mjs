import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DEFAULT_URL = 'https://www.stationhead.com/buddy46';
const DEFAULT_DURATION_MS = 45_000;
const KEYWORDS = [
  'queue', 'queue_tracks', 'current_station', 'station', 'broadcast', 'spotify_id',
  'apple_music_id', 'deezer_id', 'track', 'tracks', 'chatHistory', 'station/handle',
  'channels/alias', 'playback', 'now_playing', 'is_broadcasting',
];

function option(name, fallback = null) {
  const prefix = `${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  if (value) return value.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function safeName(value) {
  return String(value || '')
    .replace(/^https?:\/\//i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'capture';
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function containsKeyword(value) {
  const text = String(value || '').toLowerCase();
  return KEYWORDS.some((keyword) => text.includes(keyword.toLowerCase()));
}

function classifyUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('production1.stationhead.com')) return 'stationhead-api';
    if (host.includes('stationhead.com')) return 'stationhead-web';
    if (host.includes('spotify') || host.includes('scdn.co')) return 'spotify';
    return 'other';
  } catch {
    return 'unknown';
  }
}

function truncate(value, max = 4000) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    console.error('Playwright is not installed. Run: npm install --no-save playwright && npx playwright install chromium');
    throw error;
  }
}

async function maybeJson(response) {
  const headers = await response.allHeaders().catch(() => ({}));
  const contentType = String(headers['content-type'] || headers['Content-Type'] || '');
  if (!/json|javascript|text|html/i.test(contentType)) return { headers, text: null, json: null };
  let text = null;
  try {
    text = await response.text();
  } catch {
    return { headers, text: null, json: null };
  }
  let json = null;
  if (/json/i.test(contentType) || /^[\s\r\n]*[\[{]/.test(text)) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  return { headers, text, json };
}

function summarizeJson(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth > 5) return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => summarizeJson(item, depth + 1, seen));
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, 80)) {
    if (KEYWORDS.some((keyword) => key.toLowerCase().includes(keyword.toLowerCase()))) {
      result[key] = summarizeJson(child, depth + 1, seen);
    } else if (depth < 2) {
      result[key] = summarizeJson(child, depth + 1, seen);
    }
  }
  return result;
}

async function autoClick(page, outDir) {
  const candidates = await page.locator('button, [role="button"], a').evaluateAll((nodes) => nodes
    .map((node, index) => ({
      index,
      tag: node.tagName,
      text: (node.textContent || '').trim().slice(0, 120),
      aria: node.getAttribute('aria-label') || '',
      href: node.getAttribute('href') || '',
    }))
    .filter((item) => /listen|play|join|enter|station|再生|聴く|参加|▶|start/i.test(`${item.text} ${item.aria}`))
    .slice(0, 12));
  await writeFile(path.join(outDir, 'click-candidates.json'), `${JSON.stringify(candidates, null, 2)}\n`);
  if (!candidates.length) return null;
  const first = candidates[0];
  await page.locator('button, [role="button"], a').nth(first.index).click({ timeout: 5000 }).catch(() => null);
  return first;
}

async function main() {
  const targetUrl = option('--url', process.env.STATIONHEAD_DISCOVERY_URL || DEFAULT_URL);
  const durationMs = Number(option('--duration-ms', process.env.STATIONHEAD_DISCOVERY_DURATION_MS || DEFAULT_DURATION_MS));
  const headless = !flag('--headed');
  const shouldClick = flag('--auto-click');
  const now = new Date();
  const outDir = path.resolve(option('--out', path.join('.stationhead-discovery', `${safeName(targetUrl)}-${now.toISOString().replace(/[:.]/g, '-')}`)));
  await mkdir(outDir, { recursive: true });

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  const network = [];
  const candidates = [];
  const consoleMessages = [];
  const errors = [];
  const responseTasks = [];

  page.on('console', (message) => {
    consoleMessages.push({ type: message.type(), text: truncate(message.text(), 1000) });
  });
  page.on('pageerror', (error) => errors.push({ message: error.message, stack: truncate(error.stack, 2000) }));
  page.on('response', (response) => {
    const task = (async () => {
      const request = response.request();
      const url = response.url();
      const entry = {
        url,
        status: response.status(),
        method: request.method(),
        resource_type: request.resourceType(),
        source: classifyUrl(url),
        from_service_worker: response.fromServiceWorker(),
        timing: response.timing(),
      };
      network.push(entry);

      if (!['stationhead-api', 'stationhead-web'].includes(entry.source)) return;
      const { headers, text, json } = await maybeJson(response);
      entry.content_type = headers['content-type'] || headers['Content-Type'] || null;
      if (!text || !containsKeyword(`${url}\n${text}`)) return;

      const filename = `${String(candidates.length + 1).padStart(3, '0')}-${safeName(new URL(url).pathname)}-${hash(url)}.${json ? 'json' : 'txt'}`;
      await writeFile(path.join(outDir, filename), json ? `${JSON.stringify(json, null, 2)}\n` : text);
      candidates.push({
        url,
        status: entry.status,
        method: entry.method,
        resource_type: entry.resource_type,
        content_type: entry.content_type,
        file: filename,
        keyword_hit: KEYWORDS.filter((keyword) => `${url}\n${text}`.toLowerCase().includes(keyword.toLowerCase())),
        json_summary: json ? summarizeJson(json) : null,
        text_preview: json ? null : truncate(text, 1000),
      });
    })().catch((error) => {
      errors.push({ message: `response capture failed: ${error.message}`, stack: truncate(error.stack, 2000) });
    });
    responseTasks.push(task);
  });

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => null);
  const clicked = shouldClick ? await autoClick(page, outDir) : null;
  if (clicked) await page.waitForTimeout(5000);
  await page.waitForTimeout(Math.max(1000, Number.isFinite(durationMs) ? durationMs : DEFAULT_DURATION_MS));
  await Promise.allSettled(responseTasks);

  const pageState = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const scripts = [...document.scripts].map((script) => ({
      id: script.id || '',
      type: script.type || '',
      src: script.src || '',
      length: script.textContent?.length || 0,
      keyword_hit: /queue|queue_tracks|current_station|spotify_id|station|broadcast/i.test(script.textContent || script.src || ''),
      preview: /queue|queue_tracks|current_station|spotify_id|station|broadcast/i.test(script.textContent || '')
        ? (script.textContent || '').slice(0, 2000)
        : '',
    }));
    const buttons = [...document.querySelectorAll('button, [role="button"], a')].map((node) => ({
      tag: node.tagName,
      text: (node.textContent || '').trim().slice(0, 160),
      aria: node.getAttribute('aria-label') || '',
      href: node.getAttribute('href') || '',
    })).slice(0, 200);
    return {
      url: location.href,
      title: document.title,
      body_text_preview: text.slice(0, 4000),
      body_keyword_hit: /queue|current station|spotify|再生|曲|station|broadcast/i.test(text),
      scripts,
      buttons,
    };
  });

  await page.screenshot({ path: path.join(outDir, 'page.png'), fullPage: true }).catch(() => null);
  await writeFile(path.join(outDir, 'page.html'), await page.content());
  await writeFile(path.join(outDir, 'page-state.json'), `${JSON.stringify(pageState, null, 2)}\n`);
  await writeFile(path.join(outDir, 'network.json'), `${JSON.stringify(network, null, 2)}\n`);
  await writeFile(path.join(outDir, 'candidate-responses.json'), `${JSON.stringify(candidates, null, 2)}\n`);
  await writeFile(path.join(outDir, 'console.json'), `${JSON.stringify(consoleMessages, null, 2)}\n`);
  await writeFile(path.join(outDir, 'errors.json'), `${JSON.stringify(errors, null, 2)}\n`);

  const summary = [
    `# Stationhead browser discovery`,
    ``,
    `- URL: ${targetUrl}`,
    `- Output: ${outDir}`,
    `- Responses captured: ${network.length}`,
    `- Candidate responses: ${candidates.length}`,
    `- Auto click: ${clicked ? `${clicked.text || clicked.aria || clicked.href}` : 'no'}`,
    ``,
    `## Candidate URLs`,
    ...candidates.map((item) => `- ${item.method} ${item.status} ${item.url} -> ${item.file}`),
    ``,
    `## Next step`,
    `Open candidate-responses.json and the saved JSON bodies. The correct collector source should contain queue_tracks/tracks/current_station and track identifiers such as spotify_id.`,
  ].join('\n');
  await writeFile(path.join(outDir, 'summary.md'), `${summary}\n`);
  await browser.close();

  console.log(summary);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
