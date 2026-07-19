import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const PAGES_RESPONSE_KV_TITLE = 'sh-pages-read-model-pages-response-kv';
export const PAGES_RESPONSE_KV_BINDING = 'PAGES_RESPONSE_KV';

function required(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function apiErrors(payload) {
  return (Array.isArray(payload?.errors) ? payload.errors : [])
    .map((error) => String(error?.message || error?.code || '').trim())
    .filter(Boolean)
    .join('; ');
}

async function cloudflareRequest(path, init, options = {}) {
  const accountId = required(
    options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID,
    'CLOUDFLARE_ACCOUNT_ID',
  );
  const apiToken = required(
    options.apiToken
      ?? process.env.CLOUDFLARE_API_TOKEN
      ?? process.env.CLOUDFLARE_BUILDS_API_TOKEN
      ?? process.env.CF_API_TOKEN,
    'CLOUDFLARE_API_TOKEN',
  );
  const activeFetch = options.fetch || globalThis.fetch;
  const response = await activeFetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json',
        ...(init?.headers || {}),
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    throw new Error(`Cloudflare API ${path} failed: ${apiErrors(payload) || `HTTP ${response.status}`}`);
  }
  return payload;
}

export function namespaceIdFromList(payload, title = PAGES_RESPONSE_KV_TITLE) {
  const namespaces = Array.isArray(payload?.result) ? payload.result : [];
  const match = namespaces.find((namespace) => namespace?.title === title);
  const id = String(match?.id || '').trim();
  return id || null;
}

export async function ensurePagesResponseNamespace(options = {}) {
  const title = String(options.title || PAGES_RESPONSE_KV_TITLE);
  const listed = await cloudflareRequest(
    '/storage/kv/namespaces?per_page=100&order=title&direction=asc',
    { method: 'GET' },
    options,
  );
  const existingId = namespaceIdFromList(listed, title);
  if (existingId) return { id: existingId, title, created: false };

  const created = await cloudflareRequest(
    '/storage/kv/namespaces',
    { method: 'POST', body: JSON.stringify({ title }) },
    options,
  );
  return {
    id: required(created?.result?.id, 'created KV namespace id'),
    title,
    created: true,
  };
}

export function pagesReadModelConfigWithNamespaceId(source, namespaceId) {
  const config = JSON.parse(String(source));
  const bindings = Array.isArray(config.kv_namespaces) ? config.kv_namespaces : [];
  const binding = bindings.find((item) => item?.binding === PAGES_RESPONSE_KV_BINDING);
  if (!binding) throw new Error(`${PAGES_RESPONSE_KV_BINDING} binding is missing`);
  binding.id = required(namespaceId, 'KV namespace id');
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function preparePagesReadModelDeployConfig(workerRoot, options = {}) {
  const namespace = await ensurePagesResponseNamespace(options);
  const sourcePath = options.sourcePath || resolve(workerRoot, 'wrangler.pages-read-model.jsonc');
  const temporaryPath = options.temporaryPath
    || resolve(workerRoot, `.wrangler.pages-read-model.deploy-${process.pid}.jsonc`);
  const read = options.readFileSync || readFileSync;
  const write = options.writeFileSync || writeFileSync;
  const unlink = options.unlinkSync || unlinkSync;
  write(
    temporaryPath,
    pagesReadModelConfigWithNamespaceId(read(sourcePath, 'utf8'), namespace.id),
    'utf8',
  );
  return {
    namespace,
    configPath: temporaryPath,
    cleanup() {
      try { unlink(temporaryPath); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  };
}
