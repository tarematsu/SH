import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';

const migrationsUrl = new URL('../../database/migrations/', import.meta.url);
const migrationFiles = readdirSync(migrationsUrl)
  .filter((name) => /^\d+_[A-Za-z0-9._-]+\.sql$/.test(name))
  .sort();

function migrationNumber(filename) {
  return filename.match(/^(\d+)_/)?.[1] || null;
}

test('D1 migration numbers are unique', () => {
  const groups = new Map();
  for (const file of migrationFiles) {
    const number = migrationNumber(file);
    const files = groups.get(number) || [];
    files.push(file);
    groups.set(number, files);
  }

  const duplicates = [...groups.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([number, files]) => `${number}: ${files.join(', ')}`);
  assert.deepEqual(duplicates, []);
});

test('runtime repair migrations use versions beyond the applied production range', () => {
  const required = [
    '100_add_data_maintenance_state.sql',
    '101_add_lightweight_legacy_history.sql',
    '102_add_validated_stream_continuity.sql',
  ];
  for (const file of required) assert.equal(migrationFiles.includes(file), true, file);

  const removedConflicts = [
    '034_add_data_maintenance_state.sql',
    '035_add_lightweight_legacy_snapshots.sql',
    '036_add_validated_stream_count.sql',
    '037_rescope_validated_stream_history.sql',
    '038_apply_validated_stream_values.sql',
    '039_enforce_validated_current_stream.sql',
  ];
  for (const file of removedConflicts) assert.equal(migrationFiles.includes(file), false, file);
});
