import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hourBucket,
  minuteBucket,
  payloadHash,
  sourceIdentity,
} from '../site/functions/lib/ingest-claim.js';

test('time buckets are deterministic', () => {
  assert.equal(minuteBucket(1782133437000), 1782133380000);
  assert.equal(hourBucket(1782133437000), 1782133200000);
});

test('cloud collector is inferred at priority 100', () => {
  assert.deepEqual(
    sourceIdentity({ collector_id: 'cloudflare-worker' }, { collectorKind: 'external', sourcePriority: 50 }),
    { collectorId: 'cloudflare-worker', collectorKind: 'cloud', sourcePriority: 100 },
  );
});

test('local automatic and forced priorities are inferred', () => {
  assert.deepEqual(
    sourceIdentity({ collector_id: 'surface-auto' }),
    { collectorId: 'surface-auto', collectorKind: 'local', sourcePriority: 70 },
  );
  assert.deepEqual(
    sourceIdentity({ collector_id: 'surface-active' }),
    { collectorId: 'surface-active', collectorKind: 'local', sourcePriority: 80 },
  );
});

test('explicit priority overrides inference', () => {
  assert.deepEqual(
    sourceIdentity({ collector_id: 'surface-active', collector_kind: 'local', source_priority: 65 }),
    { collectorId: 'surface-active', collectorKind: 'local', sourcePriority: 65 },
  );
});

test('canonical payload hash ignores object key order', async () => {
  const a = await payloadHash({ b: 2, a: 1, nested: { y: 2, x: 1 } });
  const b = await payloadHash({ nested: { x: 1, y: 2 }, a: 1, b: 2 });
  assert.equal(a, b);
});
