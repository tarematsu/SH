import assert from 'node:assert/strict';
import test from 'node:test';

import { metadataRepairCandidates } from '../src/track-metadata.js';

test('metadata repair candidates are capped by the configured limit', () => {
  const values = [{ spotify_id: 'a' }, { spotify_id: 'b' }, { spotify_id: 'c' }];
  assert.deepEqual(metadataRepairCandidates(values, 2), values.slice(0, 2));
  assert.deepEqual(metadataRepairCandidates(values, 0), []);
});
