import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { LATEST_QUEUE_WITH_ITEMS_SQL } from '../functions/lib/latest-queue.js';

const migration = readFileSync(
  new URL('../../database/migrations/034_drop_redundant_indexes.sql', import.meta.url),
  'utf8',
);
const verifier = readFileSync(new URL('../scripts/verify-d1-schema.mjs', import.meta.url), 'utf8');

test('latest queue reads the current-state table instead of queue history', () => {
  assert.match(LATEST_QUEUE_WITH_ITEMS_SQL, /FROM sh_queue_current/);
  assert.doesNotMatch(LATEST_QUEUE_WITH_ITEMS_SQL, /FROM sh_queue_snapshots/);
});

test('redundant indexes are removed and the retired Pages verifier stays inactive', () => {
  assert.match(migration, /DROP INDEX IF EXISTS idx_sh_queue_items_station_start_position/);
  assert.match(migration, /DROP INDEX IF EXISTS idx_sh_track_metadata_spotify_fetched/);
  assert.match(verifier, /Pages has no owned database/);
  assert.doesNotMatch(verifier, /pragma_index_list\('sh_queue_items'\)/);
  assert.doesNotMatch(verifier, /redundant_queue_index/);
  assert.doesNotMatch(verifier, /redundant_metadata_index/);
});
