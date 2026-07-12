import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectorLeaseCoordination,
  readCollectorLease,
} from '../src/collector-failover-lease.js';

function missingLeaseTableDb() {
  return {
    prepare() {
      return {
        bind() { return this; },
        first() { return Promise.reject(new Error('no such table: sh_collector_leases')); },
      };
    },
  };
}

test('missing collector lease table falls back to setup-required health', async () => {
  const env = { DB: missingLeaseTableDb() };
  assert.equal(await readCollectorLease(env), null);
  const response = await collectorLeaseCoordination(env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.healthy, false);
  assert.equal(body.setup_required, true);
  assert.equal(body.holder_id, null);
  assert.equal(body.holder_kind, null);
  assert.equal(body.priority, null);
  assert.equal(body.lease_until, null);
  assert.equal(body.heartbeat_at, null);
  assert.equal(Number.isFinite(body.server_time), true);
});
