import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { runWrangler } from './cloudflare-queues.mjs';

export const RUNTIME_ANALYTICS_STREAM_NAME = 'sh_runtime_analytics_stream';
export const RUNTIME_ANALYTICS_SINK_NAME = 'sh_runtime_analytics_sink';
export const RUNTIME_ANALYTICS_PIPELINE_NAME = 'sh-runtime-analytics';
export const RUNTIME_ANALYTICS_BUCKET_NAME = 'sh-runtime-analytics';
export const RUNTIME_ANALYTICS_CATALOG_NAMESPACE = 'sh_analytics';
export const RUNTIME_ANALYTICS_CATALOG_TABLE = 'runtime_schedule';
export const RUNTIME_ANALYTICS_BINDING = 'RUNTIME_ANALYTICS_STREAM';

const STREAM_SCHEMA = 'pipelines/runtime-analytics.schema.json';
const PIPELINE_SQL = 'pipelines/runtime-analytics.sql';

function required(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function outputText(result) {
  return `${result?.stdout || ''}\n${result?.stderr || ''}`.trim();
}

function parseJsonOutput(result, label) {
  const text = outputText(result);
  const candidates = [text, ...text.split('\n').map((line) => line.trim()).filter(Boolean).toReversed()];
  for (const candidate of candidates) {
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try { return JSON.parse(candidate); } catch {}
  }
  throw new Error(`${label} did not return JSON`);
}

function resourceRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['result', 'resources', 'items', 'streams', 'sinks', 'pipelines']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function resourceName(row) {
  return String(row?.name || row?.stream_name || row?.sink_name || row?.pipeline_name || '').trim();
}

function resourceId(row) {
  return String(row?.id || row?.stream_id || row?.sink_id || row?.pipeline_id || '').trim();
}

function commandFor(kind, action, ...rest) {
  if (kind === 'pipelines') return ['pipelines', action, ...rest];
  return ['pipelines', kind, action, ...rest];
}

function listResources(kind, run) {
  const args = commandFor(kind, 'list', '--json');
  const result = run(args, { capture: true });
  return resourceRows(parseJsonOutput(result, args.join(' ')));
}

function findNamed(rows, name) {
  return rows.find((row) => resourceName(row) === name) || null;
}

function ensureNamed(kind, name, createArgs, run) {
  let row = findNamed(listResources(kind, run), name);
  if (!row) {
    run(commandFor(kind, 'create', name, ...createArgs));
    row = findNamed(listResources(kind, run), name);
  }
  if (!row) throw new Error(`Cloudflare Pipelines ${kind} resource ${name} was not found after create`);
  return {
    id: required(resourceId(row), `${kind} ${name} id`),
    name: resourceName(row) || name,
  };
}

export function runtimeConfigWithAnalyticsStream(source, streamId) {
  const config = JSON.parse(String(source));
  const pipelines = Array.isArray(config.pipelines) ? config.pipelines : [];
  const binding = pipelines.find((item) => item?.binding === RUNTIME_ANALYTICS_BINDING);
  if (binding) binding.stream = required(streamId, 'runtime analytics stream id');
  else pipelines.push({ binding: RUNTIME_ANALYTICS_BINDING, stream: required(streamId, 'runtime analytics stream id') });
  config.pipelines = pipelines;
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function ensureRuntimeAnalyticsResources(options = {}) {
  const run = options.runWrangler || runWrangler;
  const stream = ensureNamed('streams', RUNTIME_ANALYTICS_STREAM_NAME, [
    '--schema-file', STREAM_SCHEMA,
    '--http-enabled', 'false',
  ], run);

  run(['r2', 'bucket', 'create', RUNTIME_ANALYTICS_BUCKET_NAME], { allowFailure: true });
  run(['r2', 'bucket', 'catalog', 'enable', RUNTIME_ANALYTICS_BUCKET_NAME], { allowFailure: true });
  const catalogToken = required(
    options.catalogToken
      ?? process.env.CLOUDFLARE_API_TOKEN
      ?? process.env.CLOUDFLARE_BUILDS_API_TOKEN
      ?? process.env.CF_API_TOKEN,
    'Cloudflare R2 Data Catalog token',
  );
  const sink = ensureNamed('sinks', RUNTIME_ANALYTICS_SINK_NAME, [
    '--type', 'r2-data-catalog',
    '--bucket', RUNTIME_ANALYTICS_BUCKET_NAME,
    '--namespace', RUNTIME_ANALYTICS_CATALOG_NAMESPACE,
    '--table', RUNTIME_ANALYTICS_CATALOG_TABLE,
    '--catalog-token', catalogToken,
    '--compression', 'zstd',
    '--roll-interval', '300',
    '--roll-size', '100',
  ], run);
  const pipeline = ensureNamed('pipelines', RUNTIME_ANALYTICS_PIPELINE_NAME, [
    '--sql-file', PIPELINE_SQL,
  ], run);
  return { stream, sink, pipeline };
}

function directExecution() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (directExecution()) {
  const resources = ensureRuntimeAnalyticsResources();
  console.log(`RUNTIME_ANALYTICS_STREAM_ID=${resources.stream.id}`);
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_OUTPUT, `stream_id=${resources.stream.id}\n`);
  }
  console.log(JSON.stringify({ event: 'runtime_analytics_pipeline_ready', ...resources }));
}
