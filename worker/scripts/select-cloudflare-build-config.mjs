import { copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONFIG_BY_WORKER = Object.freeze({
  'sh-monitor-buddies': 'wrangler.jsonc',
  'sh-ingest-channel': 'wrangler.ingest.jsonc',
  'sh-comments': 'wrangler.comments.jsonc',
  'sh-read-model': 'wrangler.read-model.jsonc',
  'sh-monitor-other': 'wrangler.other.jsonc',
  'sh-monitor-minute': 'wrangler.minute.jsonc',
  'sh-minute-derive': 'wrangler.minute-derive.jsonc',
  'sh-minute-ingest': 'wrangler.minute-ingest.jsonc',
});

export function cloudflareBuildConfig(workerName) {
  return CONFIG_BY_WORKER[String(workerName || '').trim()] || null;
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
