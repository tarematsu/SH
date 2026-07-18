import assert from 'node:assert/strict';
import test from 'node:test';

import { pagesReadModelTask } from '../src/pages-read-model-dispatch.js';
import {
  advanceTrackHistoryPublication,
} from '../src/pages-track-history-publication.js';
import {
  assembledTrackHistoryPublicationForTest,
  createTrackHistoryPublication,
  splitTrackHistoryPublicationRows,
} from '../src/pages-track-history-response.js';
import { runSplitTrackHistoryCycleStep } from '../src/pages-track-history-split-cycle.js';

const CYCLE_START = Date.UTC(2026, 6, 18, 12, 0, 0);

function row(index) {
  return {
    row_key: `row-${String(index).padStart(4, '0')}`,
    play_date: '2026-07-18',
    first_played_at: index,
    row_json: JSON.stringify({ index, title: `Song ${index}` }),
  };
}

test('paged track-history chunks assemble the existing API response contract', () => {
  const publication = createTrackHistoryPublication(
    { generation: CYCLE_START },
    {
      generated_at: CYCLE_START,
      source_row_count: 2,
      excluded_play_count_dates: ['2026-07-01'],
    },
    CYCLE_START,
  );
  const chunks = splitTrackHistoryPublicationRows([row(1), row(2)], 0, 80);
  const payload = JSON.parse(assembledTrackHistoryPublicationForTest(publication, chunks));

  assert.equal(payload.ok, true);
  assert.equal(payload.mode, 'tracks');
  assert.equal(payload.from, '2024-05-01');
  assert.equal(payload.to, '2026-07-18');
  assert.deepEqual(payload.rows, [
    { index: 1, title: 'Song 1' },
    { index: 2, title: 'Song 2' },
  ]);
  assert.equal(payload.truncated, false);
  assert.equal(payload.likes_included, false);
  assert.equal(payload.source_row_count, 2);
  assert.deepEqual(payload.excluded_play_count_dates, ['2026-07-01']);
  assert.equal(payload.historical_recovery, 'worker_materialized_read_model');
  assert.equal(payload.method, 'precomputed_track_history_read_model');
});

test('publication advances by bounded rows and commits the manifest separately', async () => {
  const publication = {
    ...createTrackHistoryPublication(
      { generation: CYCLE_START },
      { generated_at: CYCLE_START },
      CYCLE_START,
      { PAGES_TRACK_HISTORY_ROWS_PER_STEP: 100 },
    ),
    limit: 1_000,
  };
  const written = [];
  const first = await advanceTrackHistoryPublication({}, publication, CYCLE_START + 60_000, {
    loadRows: async (_db, _state, limit) => {
      assert.equal(limit, 101);
      return Array.from({ length: 101 }, (_, index) => row(index));
    },
    writeChunks: async (_db, _state, chunks) => written.push(...chunks),
  });

  assert.equal(first.action, 'rows');
  assert.equal(first.published, false);
  assert.equal(first.rows, 100);
  assert.equal(first.publication.rows_written, 100);
  assert.equal(first.publication.phase, 'rows');
  assert.equal(first.publication.cursor.row_key, 'row-0099');
  assert.ok(written.length >= 1);

  const second = await advanceTrackHistoryPublication({}, first.publication, CYCLE_START + 120_000, {
    loadRows: async () => [row(100)],
    writeChunks: async () => {},
  });
  assert.equal(second.action, 'rows-complete');
  assert.equal(second.publication.phase, 'finalize');
  assert.equal(second.publication.rows_written, 101);

  const committed = await advanceTrackHistoryPublication({}, second.publication, CYCLE_START + 180_000, {
    publishManifest: async (_db, state) => ({ chunks: state.next_chunk_index + 1 }),
  });
  assert.equal(committed.action, 'publish');
  assert.equal(committed.published, true);
  assert.equal(committed.publication.phase, 'published');
});

test('split cycle initializes publication only after all durable shards complete', async () => {
  const savedPayloads = [];
  let savedStage = null;
  const stage = {
    generation: CYCLE_START,
    published: false,
    refresh_mode: 'incremental',
    previous_full_at: CYCLE_START - 86_400_000,
    previous_status: { source_row_count: 7, excluded_play_count_dates: [] },
    ranges: {
      recent: { fromTs: CYCLE_START - 86_400_000, toTs: CYCLE_START + 86_400_000 },
      full_recent: { fromTs: CYCLE_START - 35 * 86_400_000, toTs: CYCLE_START + 86_400_000 },
      backfill: null,
    },
    tasks: [{ id: 'recent:0', kind: 'recent', range: { fromTs: CYCLE_START, toTs: CYCLE_START + 1 } }],
    completed: {
      'recent:0': { sourceRowCount: 3, excludedDates: [] },
    },
  };

  const result = await runSplitTrackHistoryCycleStep({ BUDDIES_DB: {}, MINUTE_DB: {} }, CYCLE_START + 12 * 60_000, {
    loadStage: async () => stage,
    coverage: async () => ({ earliest_date: '2026-06-13', latest_date: '2026-07-18', recent_row_count: 9 }),
    savePayload: async (_db, key, payload) => savedPayloads.push({ key, payload }),
    initializePublication: async (_db, publication) => publication,
    saveStage: async (_db, value) => { savedStage = value; },
  });

  assert.equal(result.task.kind, 'track-history-publish-init');
  assert.equal(savedPayloads.some(({ key }) => key === 'track-history-status'), true);
  assert.equal(savedPayloads.some(({ key }) => key === 'track-history-backfill'), true);
  assert.equal(savedStage.publication.phase, 'rows');
  assert.equal(savedStage.published, false);
});

test('track-history window leaves enough cron slots for a full 100-row publication', () => {
  assert.equal(pagesReadModelTask(CYCLE_START + 120 * 60_000).kind, 'track-history-step');
  assert.equal(pagesReadModelTask(CYCLE_START + 174 * 60_000).kind, 'track-history-step');
  assert.equal(pagesReadModelTask(CYCLE_START + 175 * 60_000).key, 'minute-facts-current');
});
