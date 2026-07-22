import assert from 'node:assert/strict';
import test from 'node:test';

import {
  publishRuntimeScheduleAnalytics,
  runtimeAnalyticsDue,
  runtimeAnalyticsRecordBytes,
  runtimeScheduleAnalyticsRecord,
} from '../src/runtime-pipeline-analytics.js';
import { runRuntimeScheduled } from '../src/runtime-scheduled.js';
import {
  ensureRuntimeAnalyticsResources,
  RUNTIME_ANALYTICS_BINDING,
  runtimeConfigWithAnalyticsStream,
} from '../scripts/provision-runtime-analytics-pipeline.mjs';

const MINUTE_MS = 60_000;

function scheduledMessages(timestamp) {
  return [{
    message_type: 'raw-collection-task',
    message_version: 1,
    scheduled_at: timestamp,
  }];
}

test('Pipeline analytics publishes only on the bounded five-minute cadence', async () => {
  const sent = [];
  const stream = { async send(records) { sent.push(records); } };
  const env = { PIPELINE_ANALYTICS_INTERVAL_MINUTES: 5, RUNTIME_ANALYTICS_STREAM: stream };

  assert.equal(runtimeAnalyticsDue(10 * MINUTE_MS, env), true);
  assert.equal(runtimeAnalyticsDue(11 * MINUTE_MS, env), false);
  const skipped = await publishRuntimeScheduleAnalytics(env, scheduledMessages(11 * MINUTE_MS), 11 * MINUTE_MS);
  assert.deepEqual(skipped, { skipped: true, reason: 'interval' });

  const published = await publishRuntimeScheduleAnalytics(env, scheduledMessages(10 * MINUTE_MS), 10 * MINUTE_MS);
  assert.equal(published.skipped, false);
  assert.equal(published.records, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].event_type, 'runtime_schedule');
  assert.ok(published.bytes < 4_096);
});

test('analytics record stays narrow and excludes queue payload data', () => {
  const timestamp = Date.UTC(2026, 6, 23, 0, 10);
  const record = runtimeScheduleAnalyticsRecord([
    ...scheduledMessages(timestamp),
    {
      message_type: 'runtime-stream-prediction-dispatch',
      message_version: 1,
      scheduled_at: timestamp,
    },
  ], timestamp);
  assert.deepEqual(Object.keys(record).sort(), [
    'event_type',
    'maintenance_cron',
    'minute_gate',
    'minute_recovery',
    'observed_at',
    'raw_collection',
    'scheduled_at',
    'schema_version',
    'stream_prediction',
    'task_count',
    'worker',
  ]);
  assert.equal(record.stream_prediction, true);
  assert.ok(runtimeAnalyticsRecordBytes(record) < 1_024);
});

test('scheduled dispatch does not fail production work when analytics delivery fails', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (value) => warnings.push(String(value));
  try {
    const sentBatches = [];
    const result = await runRuntimeScheduled(
      { cron: '* * * * *', scheduledTime: 10 * MINUTE_MS },
      { HOST_MONITOR_QUEUE: { async sendBatch(messages) { sentBatches.push(messages); } } },
      null,
      { publishRuntimeAnalytics: async () => { throw new Error('pipeline unavailable'); } },
    );
    assert.equal(result[0].task, 'raw-collection');
    assert.equal(sentBatches.length, 1);
    assert.match(warnings.join('\n'), /runtime_pipeline_analytics_failed/);
  } finally {
    console.warn = originalWarn;
  }
});

test('deployment injects the created stream ID into the Worker binding', () => {
  const rendered = JSON.parse(runtimeConfigWithAnalyticsStream(JSON.stringify({
    pipelines: [{ binding: 'OTHER_STREAM', stream: 'other-id' }],
  }), 'runtime-stream-id'));
  assert.deepEqual(rendered.pipelines, [
    { binding: 'OTHER_STREAM', stream: 'other-id' },
    { binding: RUNTIME_ANALYTICS_BINDING, stream: 'runtime-stream-id' },
  ]);
});

test('provisioning creates stream, Data Catalog sink, and SQL pipeline when absent', () => {
  const resources = {
    streams: [],
    sinks: [],
    pipelines: [],
  };
  const commands = [];
  const runWrangler = (args, options = {}) => {
    commands.push([...args]);
    const [root, kind, action, name] = args;
    if (root === 'pipelines' && action === 'list' && options.capture) {
      return { status: 0, stdout: JSON.stringify(resources[kind]) };
    }
    if (root === 'pipelines' && kind === 'list' && options.capture) {
      return { status: 0, stdout: JSON.stringify(resources.pipelines) };
    }
    if (root === 'pipelines' && action === 'create') {
      resources[kind].push({ id: `${kind}-id`, name });
    } else if (root === 'pipelines' && kind === 'create') {
      resources.pipelines.push({ id: 'pipeline-id', name: action });
    }
    return { status: 0, stdout: '' };
  };

  const provisioned = ensureRuntimeAnalyticsResources({
    runWrangler,
    catalogToken: 'catalog-token',
  });
  assert.equal(provisioned.stream.id, 'streams-id');
  assert.equal(provisioned.sink.id, 'sinks-id');
  assert.equal(provisioned.pipeline.id, 'pipeline-id');
  assert.ok(commands.some((args) => args.join(' ') === (
    'pipelines streams create sh_runtime_analytics_stream '
    + '--schema-file pipelines/runtime-analytics.schema.json --http-enabled false'
  )));
  assert.ok(commands.some((args) => args.join(' ').includes(
    'pipelines sinks create sh_runtime_analytics_sink --type r2-data-catalog',
  )));
  assert.ok(commands.some((args) => args.join(' ') === (
    'pipelines create sh-runtime-analytics --sql-file pipelines/runtime-analytics.sql'
  )));
});
