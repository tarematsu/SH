import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { writeSparseLiveRevisionChunk } from '../src/minute-revision-materializer.js';

test('production derive batches two revision tracks while keeping one-message queue isolation', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.minute-derive.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.vars.DERIVE_REVISION_CHUNK_TRACKS, 2);
  assert.deepEqual(config.queues.consumers.map(({ max_batch_size }) => max_batch_size), [1, 1]);
});

test('sparse materializer respects the bounded two-track chunk', async () => {
  let requestedLimit = null;
  const result = await writeSparseLiveRevisionChunk({
    MINUTE_DB: {},
    DERIVE_REVISION_CHUNK_TRACKS: 2,
  }, {
    revision_id: 10,
    source_job_id: 20,
    visible_item_count: 8,
    total_item_count: 8,
    materialized_item_count: 0,
    preferred_position: 3,
    enrichment: { observed_at: 100_000 },
  }, {
    loadSourceTracks: async (_db, _state, limit) => {
      requestedLimit = limit;
      return [];
    },
    resolveTracksBulk: async () => [],
    materializedCount: async () => 8,
    updateCoverage: async () => {},
  });
  assert.equal(requestedLimit, 2);
  assert.equal(result.complete, true);
});
