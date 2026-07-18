import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const provisioner = await readFile(
  new URL('../worker/scripts/provision-facts-db.mjs', import.meta.url),
  'utf8',
);
const verifier = await readFile(
  new URL('../worker/scripts/verify-facts-live.mjs', import.meta.url),
  'utf8',
);

function position(source, value) {
  const index = source.indexOf(value);
  assert.notEqual(index, -1, `missing expected source fragment: ${value}`);
  return index;
}

test('facts provisioner adds both required ISRC columns before partial revision coverage', () => {
  const tracksColumnCheck = "tableColumnNames(databaseName, 'sh_tracks')";
  const tracksAlter = 'ALTER TABLE sh_tracks ADD COLUMN isrc TEXT';
  const metadataColumnCheck = "tableColumnNames(databaseName, 'sh_track_metadata')";
  const metadataMigration = "'--file', trackMetadataIsrcMigrationPath";
  const revisionColumnCheck = "tableColumnNames(databaseName, 'sh_queue_revisions')";
  const schemaMarker = "schema: 'database/facts-migrations/017_partial_queue_revision_coverage.sql'";

  assert.match(provisioner, /!trackColumns\.has\('isrc'\)/);
  assert.match(provisioner, /sh_tracks\.isrc migration did not complete/);
  assert.match(provisioner, /!trackMetadataColumns\.has\('isrc'\)/);
  assert.match(provisioner, /sh_track_metadata\.isrc migration did not complete/);
  assert.match(provisioner, /016_track_metadata_isrc\.sql/);
  assert.match(provisioner, /materialized_item_count/);
  assert.match(provisioner, /coverage_complete/);

  assert.ok(position(provisioner, tracksColumnCheck) < position(provisioner, tracksAlter));
  assert.ok(position(provisioner, tracksAlter) < position(provisioner, metadataColumnCheck));
  assert.ok(position(provisioner, metadataColumnCheck) < position(provisioner, metadataMigration));
  assert.ok(position(provisioner, metadataMigration) < position(provisioner, revisionColumnCheck));
  assert.ok(position(provisioner, revisionColumnCheck) < position(provisioner, schemaMarker));
});

test('live facts verification requires both production ISRC columns and measures revision reach', () => {
  assert.match(verifier, /pragma_table_info\('sh_tracks'\)/);
  assert.match(verifier, /pragma_table_info\('sh_track_metadata'\)/);
  assert.match(verifier, /sh_tracks_isrc_present/);
  assert.match(verifier, /sh_track_metadata_isrc_present/);
  assert.match(verifier, /revision_reach/);
  assert.match(verifier, /p95_reached_tracks/);
  assert.match(
    verifier,
    /last\.sh_tracks_isrc_present\s*&&\s*last\.sh_track_metadata_isrc_present/,
  );
  assert.match(
    verifier,
    /last\.live_fact_count > 0 && recent && requiredSchemaPresent/,
  );
});
