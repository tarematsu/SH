import assert from 'node:assert/strict';
import test from 'node:test';

import { claimPrimaryRunLock, isPrimaryRunLockActive, primaryRunLockEnabled, releasePrimaryRunLock } from '../src/primary-run-lock.js';

function fakeDb() {
  const calls = [];
  let row = null; // { scope, holder_id, claimed_at, lease_until }
  return {
    calls,
    get row() { return row; },
    prepare(sql) {
      return {
        async run() {
          calls.push({ kind: 'run', sql, params: [] });
          if (sql.startsWith('CREATE TABLE IF NOT EXISTS sh_primary_run_lock')) {
            return { meta: { changes: 0 } };
          }
          throw new Error(`unexpected direct run() for sql: ${sql}`);
        },
        bind(...params) {
          return {
            async first() {
              calls.push({ kind: 'first', sql, params });
              if (sql.startsWith('INSERT INTO sh_primary_run_lock')) {
                const [, holderId, claimedAt, leaseUntil, notBefore] = params;
                if (!row) {
                  row = { holder_id: holderId, claimed_at: claimedAt, lease_until: leaseUntil };
                  return { holder_id: holderId };
                }
                if (row.lease_until < notBefore) {
                  row = { holder_id: holderId, claimed_at: claimedAt, lease_until: leaseUntil };
                  return { holder_id: holderId };
                }
                return null;
              }
              if (sql.startsWith('SELECT lease_until FROM sh_primary_run_lock')) {
                return row ? { lease_until: row.lease_until } : null;
              }
              throw new Error(`unexpected first() for sql: ${sql}`);
            },
            async run() {
              calls.push({ kind: 'run', sql, params });
              if (sql.startsWith('UPDATE sh_primary_run_lock')) {
                const [leaseUntil, scope, holderId] = params;
                if (row && row.holder_id === holderId) {
                  row = { ...row, lease_until: leaseUntil };
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              throw new Error(`unexpected run() for sql: ${sql}`);
            },
          };
        },
      };
    },
  };
}

test('primaryRunLockEnabled defaults to true and honors explicit disable', () => {
  assert.equal(primaryRunLockEnabled({}), true);
  assert.equal(primaryRunLockEnabled({ PRIMARY_RUN_LOCK_ENABLED: 'false' }), false);
});

test('claimPrimaryRunLock fails open with no DB binding, when disabled, or on a missing table', async () => {
  assert.equal(await claimPrimaryRunLock({}, 'a'), true);
  assert.equal(await claimPrimaryRunLock({ DB: fakeDb(), PRIMARY_RUN_LOCK_ENABLED: 'false' }, 'a'), true);
  const throwingDb = { prepare() { return { bind() { return { async first() { throw new Error('no such table: sh_primary_run_lock'); } }; } }; } };
  assert.equal(await claimPrimaryRunLock({ DB: throwingDb }, 'a'), true);
});

test('claimPrimaryRunLock fails open (not closed) on an unexpected D1 error', async () => {
  const throwingDb = { prepare() { return { bind() { return { async first() { throw new Error('D1 network hiccup'); } }; } }; } };
  assert.equal(await claimPrimaryRunLock({ DB: throwingDb }, 'a'), true);
});

test('a fresh lock claims on the first attempt', async () => {
  const db = fakeDb();
  const claimed = await claimPrimaryRunLock({ DB: db }, 'run-1', 1_000);
  assert.equal(claimed, true);
  assert.equal(db.row.holder_id, 'run-1');
  assert.equal(db.row.lease_until, 1_000 + 70_000);
});

test('a fresh lock claim does not run migration-owned schema DDL', async () => {
  const db = fakeDb();
  assert.equal(await claimPrimaryRunLock({ DB: db }, 'run-1', 1_000), true);
  assert.equal(db.calls.some((call) => /CREATE TABLE/i.test(call.sql)), false);
  assert.equal(db.calls.filter((call) => call.kind === 'first').length, 1);
});

test('a second claim attempt is rejected while the first lease is still active', async () => {
  const db = fakeDb();
  assert.equal(await claimPrimaryRunLock({ DB: db }, 'run-1', 1_000), true);
  // 10s later, well inside the 70s default TTL.
  assert.equal(await claimPrimaryRunLock({ DB: db }, 'run-2', 11_000), false);
  assert.equal(db.row.holder_id, 'run-1', 'the original holder must still own the lock');
});

test('a claim succeeds again once the previous lease has expired', async () => {
  const db = fakeDb();
  assert.equal(await claimPrimaryRunLock({ DB: db }, 'run-1', 1_000), true);
  // 71s later, past the 70s default TTL.
  assert.equal(await claimPrimaryRunLock({ DB: db }, 'run-2', 72_000), true);
  assert.equal(db.row.holder_id, 'run-2');
});

test('a custom TTL is honored', async () => {
  const db = fakeDb();
  assert.equal(await claimPrimaryRunLock({ DB: db, PRIMARY_RUN_LOCK_TTL_MS: 30_000 }, 'run-1', 1_000), true);
  assert.equal(db.row.lease_until, 1_000 + 30_000);
});

test('releasePrimaryRunLock expires the lease immediately for the current holder', async () => {
  const db = fakeDb();
  await claimPrimaryRunLock({ DB: db }, 'run-1', 1_000);
  const released = await releasePrimaryRunLock({ DB: db }, 'run-1', 5_000);
  assert.equal(released, true);
  assert.equal(db.row.lease_until, 5_000);

  // The lock is immediately claimable again after release.
  assert.equal(await claimPrimaryRunLock({ DB: db }, 'run-2', 5_001), true);
});

test('releasePrimaryRunLock is a no-op for a holder that no longer owns the lock', async () => {
  const db = fakeDb();
  await claimPrimaryRunLock({ DB: db }, 'run-1', 1_000);
  await claimPrimaryRunLock({ DB: db }, 'run-2', 72_000); // run-1's lease has since expired
  const released = await releasePrimaryRunLock({ DB: db }, 'run-1', 73_000);
  assert.equal(released, false);
  assert.equal(db.row.holder_id, 'run-2', 'run-2 must still hold the lock');
});

test('releasePrimaryRunLock returns false with no DB binding', async () => {
  assert.equal(await releasePrimaryRunLock({}, 'run-1'), false);
});

test('isPrimaryRunLockActive is false with no DB binding, no row, or a missing table', async () => {
  assert.equal(await isPrimaryRunLockActive({}), false);
  assert.equal(await isPrimaryRunLockActive({ DB: fakeDb() }), false);
  const throwingDb = { prepare() { return { bind() { return { async first() { throw new Error('no such table: sh_primary_run_lock'); } }; } }; } };
  assert.equal(await isPrimaryRunLockActive({ DB: throwingDb }), false);
});

test('isPrimaryRunLockActive fails closed-to-false (not stuck-true) on an unexpected D1 error', async () => {
  const throwingDb = { prepare() { return { bind() { return { async first() { throw new Error('D1 network hiccup'); } }; } }; } };
  assert.equal(await isPrimaryRunLockActive({ DB: throwingDb }), false);
});

test('isPrimaryRunLockActive reflects a live claim and its expiry', async () => {
  const db = fakeDb();
  await claimPrimaryRunLock({ DB: db }, 'run-1', 1_000);
  assert.equal(await isPrimaryRunLockActive({ DB: db }, 11_000), true, 'well inside the 70s TTL');
  assert.equal(await isPrimaryRunLockActive({ DB: db }, 72_000), false, 'past the 70s TTL');
});
