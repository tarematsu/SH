import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../../.github/workflows/database.yml', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');
const migration = readFileSync(
  new URL('../../database/migrations/035_drop_queue_spotify_index.sql', import.meta.url),
  'utf8',
);

test('retired Pages D1 migration path cannot race current database provisioning', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /site-migrations/);
  assert.doesNotMatch(workflow, /\bschedule:/);
  assert.doesNotMatch(workflow, /sleep\s+120/);
  assert.match(workflow, /group: sh-database-operations/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /facts-db/);
  assert.match(workflow, /other-db/);
  assert.match(workflow, /buddies-db/);
});

test('facts-db auto-apply on push stays narrowly scoped to main and its own migration files', () => {
  const pushBlock = workflow.match(/^on:\n([\s\S]*?)\n(?:permissions:)/m)?.[1] || '';
  assert.match(pushBlock, /push:/);
  assert.match(pushBlock, /branches:\s*\n\s*- main/);
  assert.match(pushBlock, /paths:\s*\n(\s*- '.*'\n)+/);
  assert.doesNotMatch(pushBlock, /'\*\*'\s*$/m, 'push paths must not match the whole repo');
  assert.match(workflow, /if: github\.event_name == 'push' \|\| inputs\.operation == 'facts-db'/);
});

test('unused queue Spotify index is removed', () => {
  assert.match(migration, /DROP INDEX IF EXISTS idx_sh_queue_items_station_start_spotify/);
});
