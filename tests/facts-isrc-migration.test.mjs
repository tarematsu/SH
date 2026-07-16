import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const provisioner = await readFile(
  new URL('../worker/scripts/provision-facts-db.mjs', import.meta.url),
  'utf8',
);

test('facts provisioner adds sh_tracks.isrc before metadata backfill', () => {
  const columnCheck = "tableColumnNames(databaseName, 'sh_tracks')";
  const alter = "ALTER TABLE sh_tracks ADD COLUMN isrc TEXT";
  const backfill = "'--file', trackMetadataBackfillMigrationPath";

  assert.match(provisioner, /!trackColumns\.has\('isrc'\)/);
  assert.match(provisioner, /sh_tracks\.isrc migration did not complete/);
  assert.ok(provisioner.indexOf(columnCheck) < provisioner.indexOf(alter));
  assert.ok(provisioner.indexOf(alter) < provisioner.indexOf(backfill));
});
