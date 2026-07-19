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

test('facts provisioner adds both required ISRC columns before sparse revision state', () => {
  const tracksColumnCheck = "tableColumnNames(databaseName, 'sh_tracks')";
  const tracksAlter = 'ALTER TABLE sh_tracks ADD COLUMN isrc TEXT';
  const metadataColumnCheck = "tableColumnNames(databaseName, 'sh_track_metadata')";
  const metadataMigration = "'--file', trackMetadataIsrcMigrationPath";
  const revisionColumnCheck = "tableColumnNames(databaseName, 'sh_queue_revisions')";
  const schemaMarker = "schema: 'database/facts-migrations/019_d1_budget_indexes.sql'";

  assert.match(provisioner, /!trackColumns\.has\('isrc'\)/);
  assert.match(provisioner, /sh_tracks\.isrc migration did not complete/);
  assert.match(provisioner, /!trackMetadataColumns\.has\('isrc'\)/);
  assert.match(provisioner, /sh_track_metadata\.isrc migration did not complete/);
  assert.match(provisioner, /016_track_metadata_isrc\.sql/);
  assert.match(provisioner, /019_d1_budget_indexes\.sql/);
  assert.match(provisioner, /materialized_item_count/);
  assert.match(provisioner, /coverage_complete/);
  assert.match(provisioner, /source_job_id/);
  assert.match(provisioner, /source_visible_count/);

  assert.ok(position(provisioner, tracksColumnCheck) < position(provisioner, tracksAlter));
  assert.ok(position(provisioner, tracksAlter) < position(provisioner, metadataColumnCheck));
  assert.ok(position(provisioner, metadataColumnCheck) < position(provisioner, metadataMigration));
  assert.ok(position(provisioner, metadataMigration) < position(provisioner, revisionColumnCheck));
  assert.ok(position(provisioner, revisionColumnCheck) < position(provisioner, schemaMarker));
});

test('live facts verification requires production ISRC and sparse revision columns', () => {
  assert.match(verifier, /pragma_table_info\('sh_tracks'\)/);
  assert.match(verifier, /pragma_table_info\('sh_track_metadata'\)/);
  for (const field of [
    'sh_tracks_isrc_present',
    'sh_track_metadata_isrc_present',
    'revision_materialized_count_present',
    'revision_coverage_present',
    'revision_source_job_present',
    'revision_source_visible_present',
    'revision_checkpoint_present',
  ]) {
    assert.match(verifier, new RegExp(field));
  }
  assert.match(verifier, /revision_reach/);
  assert.match(verifier, /p95_reached_tracks/);
  assert.match(
    verifier,
    /last\.revision_source_job_present[\s\S]*last\.revision_source_visible_present[\s\S]*last\.revision_checkpoint_present/,
  );
  assert.match(
    verifier,
    /last\.live_fact_count > 0 && recent && requiredSchemaPresent/,
  );
});
