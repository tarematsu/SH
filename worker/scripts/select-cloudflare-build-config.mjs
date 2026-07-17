import { copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONFIG_BY_WORKER = Object.freeze({
  'sh-buddies-monitor': 'wrangler.jsonc',
  'sh-buddies-ingest': 'wrangler.ingest.jsonc',
  'sh-buddies-comments': 'wrangler.comments.jsonc',
  'sh-minute-read-model': 'wrangler.read-model.jsonc',
  'sh-buddies-read-model': 'wrangler.pages-read-model.jsonc',
  'sh-monitor-maintenance': 'wrangler.monitor-maintenance.jsonc',
  'sh-monitor-other': 'wrangler.other.jsonc',
  'sh-minute-maintenance': 'wrangler.minute.jsonc',
  'sh-minute-derive': 'wrangler.minute-derive.jsonc',
  'sh-minute-ingest': 'wrangler.minute-ingest.jsonc',
});

const RENAMED_WORKER_REPLACEMENTS = Object.freeze({
  'sh-monitor-buddies': 'sh-buddies-monitor',
  'sh-ingest-channel': 'sh-buddies-ingest',
  'sh-comments': 'sh-buddies-comments',
  'sh-pages-read-model': 'sh-buddies-read-model',
});

export function renamedCloudflareWorkerReplacement(workerName) {
  return RENAMED_WORKER_REPLACEMENTS[String(workerName || '').trim()] || null;
}

export function cloudflareBuildConfig(workerName) {
  const name = String(workerName || '').trim();
  const canonicalName = renamedCloudflareWorkerReplacement(name) || name;
  return CONFIG_BY_WORKER[canonicalName] || null;
}

export async function selectCloudflareBuildConfig(options = {}) {
  const workerName = String(options.workerName ?? process.env.WRANGLER_CI_OVERRIDE_NAME ?? '').trim();
  const sourceName = cloudflareBuildConfig(workerName);
  if (!sourceName || sourceName === 'wrangler.jsonc') {
    return { selected: false, workerName: workerName || null, sourceName };
  }

  const workerRoot = resolve(options.workerRoot || dirname(fileURLToPath(new URL('../package.json', import.meta.url))));
  const source = resolve(workerRoot, sourceName);
  const destination = resolve(workerRoot, 'wrangler.jsonc');
  await copyFile(source, destination);
  console.log(`Selected ${sourceName} for Cloudflare Workers Build target ${workerName}.`);
  return { selected: true, workerName, sourceName };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await selectCloudflareBuildConfig();
}
