import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { runWrangler } from './cloudflare-queues.mjs';

export const RUNTIME_ANALYTICS_STREAM_NAME = 'sh_runtime_analytics_stream';
export const RUNTIME_ANALYTICS_SINK_NAME = 'sh_runtime_analytics_sink';
export const RUNTIME_ANALYTICS_PIPELINE_NAME = 'sh-runtime-analytics';
export const RUNTIME_ANALYTICS_BUCKET_NAME = 'sh-runtime-analytics';

const STREAM_SCHEMA = 'pipelines/runtime-analytics.schema.json';
const PIPELINE_SQL = 'pipelines/runtime-analytics.sql';

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
  return { id: resourceId(row), name: resourceName(row) || name };
}

function secret(value) {
  return String(value || '').trim();
}

export function pipelineSinkCredentials(options = {}) {
  return {
    accessKeyId: secret(options.accessKeyId ?? process.env.R2_PIPELINE_ACCESS_KEY_ID),
    secretAccessKey: secret(options.secretAccessKey ?? process.env.R2_PIPELINE_SECRET_ACCESS_KEY),
  };
}

export function ensureRuntimeAnalyticsResources(options = {}) {
  const run = options.runWrangler || runWrangler;
  const stream = ensureNamed('streams', RUNTIME_ANALYTICS_STREAM_NAME, [
    '--schema-file', STREAM_SCHEMA,
    '--http-enabled', 'false',
  ], run);

  const credentials = pipelineSinkCredentials(options);
  const requireSink = options.requireSink === true
    || ['1', 'true', 'yes', 'on'].includes(String(process.env.RUNTIME_ANALYTICS_REQUIRE_SINK || '').toLowerCase());
  if (!credentials.accessKeyId || !credentials.secretAccessKey) {
    if (requireSink) {
      throw new Error('R2_PIPELINE_ACCESS_KEY_ID and R2_PIPELINE_SECRET_ACCESS_KEY are required');
    }
    return { stream, sink: null, pipeline: null, sinkSkipped: true };
  }

  run(['r2', 'bucket', 'create', RUNTIME_ANALYTICS_BUCKET_NAME], { allowFailure: true });
  const sink = ensureNamed('sinks', RUNTIME_ANALYTICS_SINK_NAME, [
    '--type', 'r2',
    '--bucket', RUNTIME_ANALYTICS_BUCKET_NAME,
    '--format', 'parquet',
    '--compression', 'zstd',
    '--roll-interval', '300',
    '--roll-size', '100',
    '--access-key-id', credentials.accessKeyId,
    '--secret-access-key', credentials.secretAccessKey,
  ], run);
  const pipeline = ensureNamed('pipelines', RUNTIME_ANALYTICS_PIPELINE_NAME, [
    '--sql-file', PIPELINE_SQL,
  ], run);
  return { stream, sink, pipeline, sinkSkipped: false };
}

function directExecution() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (directExecution()) {
  const resources = ensureRuntimeAnalyticsResources();
  if (!resources.stream.id) throw new Error('runtime analytics stream ID is missing');
  console.log(`RUNTIME_ANALYTICS_STREAM_ID=${resources.stream.id}`);
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_OUTPUT, `stream_id=${resources.stream.id}\n`);
  }
  console.log(JSON.stringify({ event: 'runtime_analytics_pipeline_ready', ...resources }));
}
