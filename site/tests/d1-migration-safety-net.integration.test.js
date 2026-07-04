import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../../.github/workflows/d1-migration-safety-net.yml', import.meta.url),
  'utf8',
);
const migration = readFileSync(
  new URL('../../database/migrations/035_drop_queue_spotify_index.sql', import.meta.url),
  'utf8',
);

test('automatic D1 recovery only runs for migration-related main changes', () => {
  assert.match(workflow, /branches:\s*\n\s*- main/);
  assert.match(workflow, /database\/migrations\/\*\*/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /sleep 120/);
  assert.match(workflow, /npm run db:migrate/);
  assert.match(workflow, /npm run db:verify/);
});

test('unused queue Spotify index is removed', () => {
  assert.match(migration, /DROP INDEX IF EXISTS idx_sh_queue_items_station_start_spotify/);
});
