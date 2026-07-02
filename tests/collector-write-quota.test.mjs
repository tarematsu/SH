import test from 'node:test';
import assert from 'node:assert/strict';

import {
  claimWrite,
  QUEUE_DUPLICATE_WINDOW_MS,
} from '../site/functions/lib/ingest-claim.js';

function mockClaims({ exact = null, recent = null } = {}) {
  let writes = 0;
  let recentLookups = 0;
  return {
    get writes() { return writes; },
    get recentLookups() { return recentLookups; },
    prepare(sql) {
      if (/WHERE dedupe_key=\?/.test(sql)) {
        return { bind() { return this; }, async first() { return exact; } };
      }
      if (/data_type='queue' AND payload_hash=\?/.test(sql)) {
        recentLookups += 1;
        return { bind() { return this; }, async first() { return recent; } };
      }
      return { bind() { return this; }, async run() { writes += 1; return { meta: { changes: 1 } }; } };
    },
  };
}

test('unchanged queue payload is checkpointed instead of rewritten every minute', async () => {
  const db = mockClaims({ recent: {
    collector_id: 'cloudflare-worker', collector_kind: 'cloud', source_priority: 100,
    observed_at: 100, payload_hash: 'same', first_seen_at: 50,
  } });
  const result = await claimWrite(db, {
    dedupeKey: 'queue:minute:2', dataType: 'queue', collectorId: 'cloudflare-worker',
    collectorKind: 'cloud', sourcePriority: 100,
    observedAt: 100 + QUEUE_DUPLICATE_WINDOW_MS - 1, hash: 'same',
  });
  assert.equal(result.accepted, false);
  assert.equal(result.duplicate, true);
  assert.equal(result.reason, 'same_queue_payload_checkpoint');
  assert.equal(db.recentLookups, 1);
  assert.equal(db.writes, 0);
});

test('changed queue payload still creates a new canonical claim', async () => {
  const db = mockClaims();
  const result = await claimWrite(db, {
    dedupeKey: 'queue:minute:2', dataType: 'queue', collectorId: 'cloudflare-worker',
    collectorKind: 'cloud', sourcePriority: 100, observedAt: 200, hash: 'changed',
  });
  assert.equal(result.accepted, true);
  assert.equal(result.duplicate, false);
  assert.equal(db.writes, 1);
});

test('higher priority queue source may replace a recent lower priority payload', async () => {
  const db = mockClaims({ recent: {
    collector_id: 'surface-auto', collector_kind: 'local', source_priority: 70,
    observed_at: 100, payload_hash: 'same', first_seen_at: 50,
  } });
  const result = await claimWrite(db, {
    dedupeKey: 'queue:minute:2', dataType: 'queue', collectorId: 'cloudflare-worker',
    collectorKind: 'cloud', sourcePriority: 100, observedAt: 200, hash: 'same',
  });
  assert.equal(result.accepted, true);
  assert.equal(db.writes, 1);
});

test('same-priority exact duplicate does not refresh the claim row', async () => {
  const db = mockClaims({ exact: {
    collector_id: 'cloudflare-worker', collector_kind: 'cloud', source_priority: 100,
    observed_at: 100, payload_hash: 'same', first_seen_at: 50,
  } });
  const result = await claimWrite(db, {
    dedupeKey: 'queue:minute:1', dataType: 'queue', collectorId: 'cloudflare-worker',
    collectorKind: 'cloud', sourcePriority: 100, observedAt: 200, hash: 'same',
  });
  assert.equal(result.reason, 'same_payload');
  assert.equal(db.writes, 0);
});
