import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../../.github/workflows/database.yml', import.meta.url),
  'utf8',
);
const migration = readFileSync(
  new URL('../../database/migrations/035_drop_queue_spotify_index.sql', import.meta.url),
  'utf8',
);

test('D1 recovery remains a manual fallback and cannot race deployments', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\bpush:/);
  assert.doesNotMatch(workflow, /\bschedule:/);
  assert.doesNotMatch(workflow, /sleep\s+120/);
  assert.match(workflow, /group: sh-database-operations/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /D1_MIGRATION_FORCE: ['"]true['"]/);
  assert.match(workflow, /D1_MIGRATION_TARGET: remote/);
  assert.match(workflow, /npm run db:migrate/);
  assert.match(workflow, /npm run db:verify/);
});

test('unused queue Spotify index is removed', () => {
  assert.match(migration, /DROP INDEX IF EXISTS idx_sh_queue_items_station_start_spotify/);
});
