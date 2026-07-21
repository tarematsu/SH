import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('monitor maintenance caches only current rollup and retention modules', () => {
  const entry = source('../src/monitor-maintenance-entry.js');
  assert.match(entry, /cronStaggerModulePromise \|\|=/);
  assert.match(entry, /rollupModulePromise \|\|=/);
  assert.match(entry, /retentionModulePromise \|\|=/);
  assert.match(entry, /const EMPTY_DEPENDENCIES = Object\.freeze/);
  assert.match(entry, /export default \{\s*scheduled:/s);
  assert.doesNotMatch(entry, /buddy|hostMonitor|fetch\s*\(/i);
});

test('runtime stream prediction is a single lazy scheduled dependency', () => {
  const dispatch = source('../src/runtime-other-monitor-dispatch.js');
  assert.match(dispatch, /predictionModulePromise \|\|=/);
  assert.match(dispatch, /runStreamGoalPrediction/);
  assert.match(dispatch, /otherMonitorDue/);
  assert.doesNotMatch(dispatch, /buddy|host|officialNews|Queue/i);
  assert.equal(existsSync(new URL('../src/other-monitor-entry.js', import.meta.url)), false);
});

test('runtime orchestration is split by scheduled, Queue, and environment responsibilities', () => {
  const config = source('../wrangler.runtime.jsonc');
  assert.match(config, /"main"\s*:\s*"src\/runtime-orchestrator-entry\.js"/);

  const entry = source('../src/runtime-orchestrator-entry.js');
  assert.match(entry, /runRuntimeScheduled/);
  assert.match(entry, /runRuntimeQueue/);
  assert.doesNotMatch(entry, /for \(const message of messages\)/);

  const scheduled = source('../src/runtime-scheduled.js');
  assert.match(scheduled, /runtimeScheduledMessagesFor/);
  assert.match(scheduled, /HOST_MONITOR_QUEUE/);
  assert.match(scheduled, /sendBatch/);
  assert.match(scheduled, /RUNTIME_MINUTE_RECOVERY_MESSAGE/);
  assert.match(scheduled, /RUNTIME_MINUTE_GATE_MESSAGE/);
  assert.match(scheduled, /RUNTIME_OTHER_MONITOR_MESSAGE/);
  assert.doesNotMatch(scheduled, /buddy|host-monitor-task|other-monitor-select/i);

  const queue = source('../src/runtime-queue.js');
  assert.match(queue, /for \(const message of messages\)/);
  assert.match(queue, /rawCollectionSessionModulePromise \|\|=/);
  assert.match(queue, /rawCollectionFetchModulePromise \|\|=/);
  assert.match(queue, /processRuntimeDispatchMessage/);
  assert.match(queue, /unsupported_runtime_message_discarded/);
  assert.doesNotMatch(queue, /otherMonitorModulePromise|runOtherMonitorQueue/);

  const env = source('../src/runtime-env.js');
  assert.match(env, /function withDatabaseAlias/);
  assert.match(env, /export function minutePipelineEnv/);
});
