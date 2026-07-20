export const RETIRED_WORKER_NAMES = Object.freeze([
  'sh-monitor-other',
  'sh-buddies-monitor',
  'sh-buddies-persist',
  'sh-buddies-comments',
  'sh-buddy-playback',
  'sh-host-monitor',
  'sh-buddies-read-model',
  'sh-minute-maintenance',
  'sh-monitor-maintenance',
  'sh-minute-derive',
  'sh-minute-ingest',
  'sh-minute-rebuild',
  'sh-track-metadata',
  'sh-pages-read-model',
  'sh-minute-read-model',
]);

function credentials() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN
    || process.env.CLOUDFLARE_BUILDS_API_TOKEN
    || process.env.CF_API_TOKEN;
  if (!accountId || !token) throw new Error('Cloudflare account credentials are unavailable');
  return { accountId, token };
}

async function workerRequest(scriptName, method = 'GET') {
  const { accountId, token } = credentials();
  return fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}${method === 'DELETE' ? '?force=true' : ''}`,
    {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    },
  );
}

function isNotFound(response, body) {
  return response.status === 404
    || body?.errors?.some((error) => /not found/i.test(String(error?.message || '')));
}

export async function deleteWorker(scriptName) {
  const response = await workerRequest(scriptName, 'DELETE');
  const body = await response.json().catch(() => null);
  if ((!response.ok || body?.success === false) && !isNotFound(response, body)) {
    const detail = body?.errors?.map((error) => error?.message).filter(Boolean).join('; ')
      || `HTTP ${response.status}`;
    throw new Error(`retired Worker ${scriptName} deletion failed: ${detail}`);
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const verification = await workerRequest(scriptName);
    if (verification.status === 404) return;
    if (verification.status < 500 || attempt === 3) {
      throw new Error(`retired Worker ${scriptName} is still reachable: HTTP ${verification.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
}

export async function pruneRetiredWorkers(names = RETIRED_WORKER_NAMES) {
  for (const name of names) await deleteWorker(name);
}
