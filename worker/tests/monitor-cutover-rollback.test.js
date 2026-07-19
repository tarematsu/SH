import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../scripts/deploy-other-monitor.mjs', import.meta.url),
  'utf8',
);

test('monitor consolidation rolls back before the old collector is retired', () => {
  assert.match(source, /rollbackConsolidated\(\)/);
  assert.match(source, /'rollback',[\s\S]*'--name', consolidatedScript/);
  assert.match(source, /Automatic rollback after monitor consolidation cutover failure/);
  assert.match(source, /if \(consolidatedDeployed && !collectorRetired\)/);
});

test('the every-minute collector is retired only after deployment, consumers, and queue resume succeed', () => {
  const deployment = source.indexOf("runWrangler(['deploy', '--config', 'wrangler.other.jsonc'])");
  const consumerCheck = source.indexOf('assertConsolidatedConsumers();', deployment);
  const resume = source.indexOf('for (const item of paused) resume(item.queue);', consumerCheck);
  const retirement = source.indexOf('await deleteOldWorker(collectorScript);', resume);
  const successLog = source.indexOf("event: 'monitor_worker_consolidation_completed'", retirement);

  assert.ok(deployment >= 0);
  assert.ok(consumerCheck > deployment);
  assert.ok(resume > consumerCheck);
  assert.ok(retirement > resume);
  assert.ok(successLog > retirement);
  assert.doesNotMatch(source.slice(retirement, successLog), /assertConsolidatedConsumers\(|runWrangler\(/);
});

test('rollback failures are surfaced instead of masking the original cutover failure', () => {
  assert.match(source, /throw new AggregateError\(/);
  assert.match(source, /monitor consolidation failed and rollback was incomplete/);
  assert.match(source, /Failed to resume/);
  assert.match(source, /Failed to restore/);
});
