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

test('facts provisioner installs ISRC identity, dictionary and stats in order', () => {
  const tracksColumnCheck = "tableColumnNames(databaseName, 'sh_tracks')";
  const tracksAlter = 'ALTER TABLE sh_tracks ADD COLUMN isrc TEXT';
  const metadataColumnCheck = "tableColumnNames(databaseName, 'sh_track_metadata')";
  const metadataMigration = "'--file', trackMetadataIsrcMigrationPath";
  const revisionColumnCheck = "tableColumnNames(databaseName, 'sh_queue_revisions')";
  const dictionaryColumnCheck = "tableColumnNames(databaseName, 'sh_track_dictionary')";
  const dictionaryMigration = "'--file', isrcTrackDictionaryMigrationPath";
  const schemaMarker = "schema: 'database/facts-migrations/020_isrc_track_dictionary.sql'";

  assert.match(provisioner, /!trackColumns\.has\('isrc'\)/);
  assert.match(provisioner, /sh_tracks\.isrc migration did not complete/);
  assert.match(provisioner, /!trackMetadataColumns\.has\('isrc'\)/);
  assert.match(provisioner, /sh_track_metadata\.isrc migration did not complete/);
  assert.match(provisioner, /016_track_metadata_isrc\.sql/);
  assert.match(provisioner, /019_d1_budget_indexes\.sql/);
  assert.match(provisioner, /020_isrc_track_dictionary\.sql/);
  assert.match(provisioner, /sh_track_dictionary migration did not complete/);
  assert.match(provisioner, /sh_track_stats_by_isrc view migration did not complete/);
  assert.match(provisioner, /materialized_item_count/);
  assert.match(provisioner, /coverage_complete/);
  assert.match(provisioner, /source_job_id/);
  assert.match(provisioner, /source_visible_count/);

  assert.ok(position(provisioner, tracksColumnCheck) < position(provisioner, tracksAlter));
  assert.ok(position(provisioner, tracksAlter) < position(provisioner, metadataColumnCheck));
  assert.ok(position(provisioner, metadataColumnCheck) < position(provisioner, metadataMigration));
  assert.ok(position(provisioner, metadataMigration) < position(provisioner, revisionColumnCheck));
  assert.ok(position(provisioner, revisionColumnCheck) < position(provisioner, dictionaryColumnCheck));
  assert.ok(position(provisioner, dictionaryColumnCheck) < position(provisioner, dictionaryMigration));
  assert.ok(position(provisioner, dictionaryMigration) < position(provisioner, schemaMarker));
});

test('live facts verification requires the ISRC dictionary and latest stats view', () => {
  assert.match(verifier, /pragma_table_info\('sh_tracks'\)/);
  assert.match(verifier, /pragma_table_info\('sh_track_metadata'\)/);
  assert.match(verifier, /pragma_table_info\('sh_track_dictionary'\)/);
  assert.match(verifier, /pragma_table_info\('sh_track_stats_by_isrc'\)/);
  for (const field of [
    'sh_tracks_isrc_present',
    'sh_track_metadata_isrc_present',
    'track_dictionary_present',
    'track_dictionary_thumbnail_present',
    'track_stats_by_isrc_present',
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
    /last\.track_dictionary_present[\s\S]*last\.track_dictionary_thumbnail_present[\s\S]*last\.track_stats_by_isrc_present/,
  );
  assert.match(
    verifier,
    /last\.live_fact_count > 0 && recent && requiredSchemaPresent/,
  );
});
