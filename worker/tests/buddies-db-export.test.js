import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalizeD1Export,
  countD1ExportRows,
  ownershipPolicyRequiresCleanup,
  splitSqlValues,
} from '../scripts/buddies-db-export.mjs';

test('canonical D1 export digest input ignores statement and schema column order', () => {
  const left = `PRAGMA defer_foreign_keys=TRUE;
INSERT INTO "state" ("id","payload","updated_at") VALUES('one','comma, and it''s quoted',2);
INSERT INTO "state" ("id","payload","updated_at") VALUES('two',NULL,3);`;
  const right = `PRAGMA defer_foreign_keys=TRUE;\r
INSERT INTO "state" ("updated_at","payload","id") VALUES(3,NULL,'two');\r
INSERT INTO "state" ("updated_at","payload","id") VALUES(2,'comma, and it''s quoted','one');`;
  assert.equal(canonicalizeD1Export(left), canonicalizeD1Export(right));
});

test('SQL export value splitter preserves commas and escaped quotes in literals', () => {
  assert.deepEqual(splitSqlValues("1,'a,b','it''s fine',NULL"), [
    '1', "'a,b'", "'it''s fine'", 'NULL',
  ]);
  assert.throws(() => splitSqlValues("1,'broken"), /Unterminated/);
});

test('D1 export row counts are table-specific', () => {
  const sql = `INSERT INTO "first" ("id") VALUES(1);
INSERT INTO "second" ("id") VALUES(1);
INSERT INTO "first" ("id") VALUES(2);`;
  assert.deepEqual(countD1ExportRows(sql, ['first', 'second', 'empty']), {
    first: 2,
    second: 1,
    empty: 0,
  });
});

test('verify mode never applies the destructive ownership cleanup', () => {
  assert.equal(ownershipPolicyRequiresCleanup('verify'), false);
  assert.equal(ownershipPolicyRequiresCleanup('seed'), true);
  assert.equal(ownershipPolicyRequiresCleanup('finalize'), true);
});
