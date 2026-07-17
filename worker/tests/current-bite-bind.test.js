import assert from 'node:assert/strict';
import test from 'node:test';

import { writeCurrentBite } from '../src/minute-facts-legacy-revision.js';

test('writeCurrentBite converts missing optional metadata to null before D1 bind', async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          calls.push({ sql, values });
          return {
            first: async () => sql.includes('SELECT track_id')
              ? { track_id: 91 }
              : null,
            run: async () => ({ success: true }),
          };
        },
      };
    },
  };

  const result = await writeCurrentBite(db, {
    channelId: 318,
    stationId: undefined,
    revisionId: 322,
    position: 0,
    observedAt: 1_784_214_000_000,
    queue: {
      tracks: [{ position: 0, bite_count: 7 }],
    },
  });

  assert.equal(result, 7);
  const insert = calls.find(({ sql }) => sql.includes('INSERT OR IGNORE INTO sh_track_counter_changes'));
  assert.ok(insert);
  assert.equal(insert.values.length, 20);
  assert.equal(insert.values.includes(undefined), false);
  assert.equal(insert.values[3], null);
  assert.equal(insert.values[4], null);
  assert.equal(insert.values[7], null);
  assert.equal(insert.values[8], null);
  assert.equal(insert.values[9], null);
  assert.equal(insert.values[10], null);
  assert.equal(insert.values[11], null);
  assert.equal(insert.values[18], 7);
  assert.equal(insert.values[19], 'revision:322:0');
});
