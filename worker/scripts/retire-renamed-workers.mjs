import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RENAMED_WORKERS = Object.freeze([
  { legacy: 'sh-monitor-buddies', replacement: 'sh-buddies-monitor' },
  { legacy: 'sh-ingest-channel', replacement: 'sh-buddies-ingest' },
  { legacy: 'sh-comments', replacement: 'sh-buddies-comments' },
  { legacy: 'sh-buddies-read-model', replacement: 'sh-pages-read-model' },
]);

function configuredToken(options = {}) {
  return String(
    options.token
    ?? process.env.CLOUDFLARE_API_TOKEN
    ?? process.env.CLOUDFLARE_BUILDS_API_TOKEN
    ?? process.env.CF_API_TOKEN
    ?? '',
  ).trim();
}

export async function retireRenamedWorkers(options = {}) {
  const accountId = String(options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  const token = configuredToken(options);
  const activeFetch = options.fetch || globalThis.fetch;
  const log = options.log || console.log;
  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required');
  if (!token) throw new Error('Cloudflare API token is required');
  if (typeof activeFetch !== 'function') throw new Error('fetch is required');

  const summary = { retired: [], already_retired: [] };
  const headers = { Authorization: `Bearer ${token}` };
  for (const worker of RENAMED_WORKERS) {
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${worker.legacy}`;
    const response = await activeFetch(endpoint, { method: 'DELETE', headers });
    if (response.status === 404) {
      summary.already_retired.push(worker.legacy);
      log(`${worker.legacy} is already retired; replacement=${worker.replacement}.`);
      continue;
    }
    if (!response.ok) {
      throw new Error(`failed to retire ${worker.legacy}: ${response.status} ${await response.text()}`);
    }
    summary.retired.push(worker.legacy);
    log(`Retired renamed Worker ${worker.legacy}; replacement=${worker.replacement}.`);
  }
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await retireRenamedWorkers();
}
