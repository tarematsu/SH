import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceConfigPath = resolve(workerRoot, 'wrangler.pages-read-model.jsonc');
const NAMESPACE_TITLE = 'sh-pages-read-model-pages-response-kv';
const KV_BINDING = 'PAGES_RESPONSE_KV';

function required(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function apiErrors(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  return errors
    .map((error) => String(error?.message || error?.code || '').trim())
    .filter(Boolean)
    .join('; ');
}

async function cloudflareRequest(path, init, options = {}) {
  const accountId = required(
    options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID,
    'CLOUDFLARE_ACCOUNT_ID',
  );
  const apiToken = required(
    options.apiToken ?? process.env.CLOUDFLARE_API_TOKEN,
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
    const detail = apiErrors(payload) || `HTTP ${response.status}`;
    throw new Error(`Cloudflare API ${path} failed: ${detail}`);
  }
  return payload;
}

export function namespaceIdFromList(payload, title = NAMESPACE_TITLE) {
  const namespaces = Array.isArray(payload?.result) ? payload.result : [];
  const match = namespaces.find((namespace) => namespace?.title === title);
  const id = String(match?.id || '').trim();
  return id || null;
}

export async function ensurePagesResponseNamespace(options = {}) {
  const title = String(options.title || NAMESPACE_TITLE);
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
  const id = required(created?.result?.id, 'created KV namespace id');
  return { id, title, created: true };
}

export function pagesReadModelConfigWithNamespaceId(source, namespaceId) {
  const config = JSON.parse(String(source));
  const bindings = Array.isArray(config.kv_namespaces) ? config.kv_namespaces : [];
  const binding = bindings.find((item) => item?.binding === KV_BINDING);
  if (!binding) throw new Error(`${KV_BINDING} binding is missing from the Pages read-model config`);
  binding.id = required(namespaceId, 'KV namespace id');
  return `${JSON.stringify(config, null, 2)}\n`;
}

function runWrangler(configPath, options = {}) {
  const executable = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler';
  const result = (options.spawnSync || spawnSync)(
    executable,
    ['deploy', '--config', configPath, ...(options.args || process.argv.slice(2))],
    {
      cwd: options.workerRoot || workerRoot,
      stdio: 'inherit',
      env: process.env,
    },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`wrangler deploy terminated by ${result.signal}`);
  if (Number(result.status) !== 0) throw new Error(`wrangler deploy exited with status ${result.status}`);
}

export async function deployPagesReadModel(options = {}) {
  const root = options.workerRoot || workerRoot;
  const sourcePath = options.sourceConfigPath || sourceConfigPath;
  const namespace = await ensurePagesResponseNamespace(options);
  const temporaryPath = resolve(root, `.wrangler.pages-read-model.deploy-${process.pid}.jsonc`);
  const source = (options.readFileSync || readFileSync)(sourcePath, 'utf8');
  const rendered = pagesReadModelConfigWithNamespaceId(source, namespace.id);
  (options.writeFileSync || writeFileSync)(temporaryPath, rendered, 'utf8');

  console.log(JSON.stringify({
    event: 'pages_response_kv_namespace_resolved',
    namespace_id: namespace.id,
    namespace_title: namespace.title,
    created: namespace.created,
  }));

  try {
    runWrangler(temporaryPath, { ...options, workerRoot: root });
  } finally {
    try {
      (options.unlinkSync || unlinkSync)(temporaryPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return namespace;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await deployPagesReadModel();
}
