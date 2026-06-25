import test from 'node:test';
import assert from 'node:assert/strict';
import { hostScopeFromSnapshot } from '../site/functions/api/dashboard.js';

test('host account id takes precedence for host-scoped comparisons', () => {
  assert.deepEqual(
    hostScopeFromSnapshot({ host_account_id: 3334889, host_handle: 'sakuramankai' }),
    { column: 'host_account_id', value: 3334889 },
  );
});

test('host handle is used when account id is unavailable', () => {
  assert.deepEqual(
    hostScopeFromSnapshot({ host_account_id: null, host_handle: ' sakuramankai ' }),
    { column: 'host_handle', value: 'sakuramankai' },
  );
});

test('missing host information yields no scope', () => {
  assert.equal(hostScopeFromSnapshot({ host_account_id: null, host_handle: '  ' }), null);
});
