import assert from 'node:assert/strict';
import test from 'node:test';

import { advanceTrackHistoryR2Publication } from '../src/pages-track-history-publication.js';
import {
  createTrackHistoryPublication,
} from '../src/pages-track-history-response.js';
import {
  processTrackHistoryPublicationTask,
  TRACK_HISTORY_PUBLICATION_ACTIONS,
  TRACK_HISTORY_PUBLICATION_MESSAGE,
} from '../src/pages-track-history-publication-queue.js';

const DAY = 86_400_000;
const START = Date.UTC(2026, 6, 22);

function publication(overrides = {}) {
  return {
    ...createTrackHistoryPublication(
      { generation: START },
      { generated_at: START + DAY, source_row_count: 3 },
      START + DAY,
      { PAGES_RESPONSE_R2: { get() {}, put() {} } },
    ),
    from: '2026-07-22',
    to: '2026-07-23',
    page_days: 30,
    ...overrides,
  };
}

test('R2 publication traverses day models without invoking the D1 row pager', async () => {
  const requested = [];
  const db = {
    prepare() {
      throw new Error('legacy D1 row pager must not run');
    },
  };
  const result = await advanceTrackHistoryR2Publication(
    db,
    { get() {}, put() {} },
    publication(),
    START + 2 * DAY,
    86_400,
    {
      async loadDay(_r2, day) {
        requested.push(day);
        return { payload: { rows: [] } };
      },
      async bootstrapDay() {
        throw new Error('complete R2 day models must not bootstrap from D1');
      },
      async publishR2(_r2, state, _now, cadence) {
        assert.equal(cadence, 86_400);
        assert.equal(state.day_cursor, '2026-07-24');
        return { published: true, rows: 3, truncated: false, chunks: 1, storage: 'r2' };
      },
    },
  );

  assert.deepEqual(requested, ['2026-07-22', '2026-07-23']);
  assert.equal(result.published, true);
  assert.equal(result.action, 'publish-r2-days');
  assert.equal(result.publication.phase, 'published');
  assert.equal(result.storage, 'r2');
});

test('R2 publication bootstraps only a missing indexed day and checkpoints progress', async () => {
  const bootstrapped = [];
  const first = await advanceTrackHistoryR2Publication(
    {},
    { get() {}, put() {} },
    publication({ page_days: 1 }),
    START + 2 * DAY,
    86_400,
    {
      async loadDay() { return null; },
      async bootstrapDay(_db, _r2, day) { bootstrapped.push(day); },
      async publishR2() { throw new Error('first page must checkpoint before publish'); },
    },
  );

  assert.equal(first.published, false);
  assert.equal(first.action, 'r2-days');
  assert.equal(first.publication.day_cursor, '2026-07-23');
  assert.deepEqual(bootstrapped, ['2026-07-22']);
});

test('publication Queue routes r2-days state away from legacy D1 advancement and promotion', async () => {
  const stage = {
    generation: START,
    published: false,
    publication: publication({ generation: 'r2-generation' }),
  };
  const calls = [];
  const result = await processTrackHistoryPublicationTask({
    MINUTE_DB: {},
    PAGES_RESPONSE_R2: {},
  }, {
    message_type: TRACK_HISTORY_PUBLICATION_MESSAGE,
    message_version: 2,
    action: TRACK_HISTORY_PUBLICATION_ACTIONS.PAGE,
    generation: 'r2-generation',
  }, {
    now: () => START + DAY,
    loadStage: async () => stage,
    async advanceR2Publication() {
      calls.push('r2');
      return {
        action: 'publish-r2-days',
        published: true,
        rows: 3,
        chunks: 1,
        storage: 'r2',
        publication: { ...stage.publication, phase: 'published', rows_written: 3 },
      };
    },
    async advancePublication() { calls.push('legacy'); throw new Error('legacy advancement used'); },
    async promoteResponse() { calls.push('promote'); throw new Error('D1 promotion used'); },
    async saveStage() { calls.push('save'); },
  });

  assert.deepEqual(calls, ['r2', 'save']);
  assert.equal(result.published, true);
  assert.equal(result.storage, 'r2');
});
