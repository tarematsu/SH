import { connectedWorkerBuildWatchConfig } from './select-worker-deploys.mjs';

const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
const apiToken = String(
  process.env.CLOUDFLARE_BUILDS_API_TOKEN
  || process.env.CLOUDFLARE_API_TOKEN
  || process.env.CF_API_TOKEN
  || '',
).trim();
const apiBase = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`;

if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required');
if (!apiToken) throw new Error('A Cloudflare API token is required');

async function cloudflare(method, endpoint, body = null) {
  const response = await fetch(`${apiBase}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Cloudflare API returned non-JSON (${response.status})`);
  }
  if (!response.ok || payload.success === false) {
    const detail = (payload.errors || [])
      .map((error) => `${error.code || 'error'}: ${error.message || 'request failed'}`)
      .join('; ');
    throw new Error(`Cloudflare API ${response.status}: ${detail || 'request failed'}`);
  }
  return payload.result;
}

const scripts = await cloudflare('GET', '/workers/scripts');
const tags = new Map((scripts || []).map((script) => [String(script.id), String(script.tag || '')]));
const watchConfig = connectedWorkerBuildWatchConfig();
const updated = [];

for (const [workerName, pathIncludes] of Object.entries(watchConfig)) {
  const tag = tags.get(workerName);
  if (!tag) throw new Error(`Worker not found: ${workerName}`);
  const triggers = await cloudflare('GET', `/builds/workers/${encodeURIComponent(tag)}/triggers`);
  if (!Array.isArray(triggers) || triggers.length === 0) {
    throw new Error(`No Workers Builds trigger found for ${workerName}`);
  }

  for (const trigger of triggers) {
    const triggerUuid = String(trigger?.trigger_uuid || '');
    if (!triggerUuid) throw new Error(`Trigger UUID is missing for ${workerName}`);
    const result = await cloudflare(
      'PATCH',
      `/builds/triggers/${encodeURIComponent(triggerUuid)}`,
      { path_includes: pathIncludes, path_excludes: [] },
    );
    const actual = [...(result?.path_includes || [])].sort();
    const expected = [...pathIncludes].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Build watch paths did not persist for ${workerName}/${triggerUuid}`);
    }
    updated.push({
      worker: workerName,
      trigger_uuid: triggerUuid,
      trigger_name: result?.trigger_name || trigger?.trigger_name || null,
      branch_includes: result?.branch_includes || trigger?.branch_includes || [],
      branch_excludes: result?.branch_excludes || trigger?.branch_excludes || [],
      path_count: expected.length,
    });
  }
}

console.log(JSON.stringify({ ok: true, updated }, null, 2));
