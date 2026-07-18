import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { pagesReadModelTask } from '../src/pages-read-model-dispatch.js';
import {
  advanceTrackHistoryPublication,
} from '../src/pages-track-history-publication.js';
import {
  processTrackHistoryPublicationTask,
  TRACK_HISTORY_PUBLICATION_MESSAGE,
} from '../src/pages-track-history-publication-queue.js';
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
      { PAGES_TRACK_HISTORY_ROWS_PER_STEP: 40 },
    ),
    limit: 1_000,
  };
  const written = [];
  const first = await advanceTrackHistoryPublication({}, publication, CYCLE_START + 60_000, {
    loadRows: async (_db, _state, limit) => {
      assert.equal(limit, 41);
      return Array.from({ length: 41 }, (_, index) => row(index));
    },
    writeChunks: async (_db, _state, chunks) => written.push(...chunks),
  });

  assert.equal(first.action, 'rows');
  assert.equal(first.published, false);
  assert.equal(first.rows, 40);
  assert.equal(first.publication.rows_written, 40);
  assert.equal(first.publication.phase, 'rows');
  assert.equal(first.publication.cursor.row_key, 'row-0039');
  assert.ok(written.length >= 1);

  const second = await advanceTrackHistoryPublication({}, first.publication, CYCLE_START + 120_000, {
    loadRows: async () => [row(40)],
    writeChunks: async () => {},
  });
  assert.equal(second.action, 'rows-complete');
  assert.equal(second.publication.phase, 'finalize');
  assert.equal(second.publication.rows_written, 41);

  const committed = await advanceTrackHistoryPublication({}, second.publication, CYCLE_START + 180_000, {
    publishManifest: async (_db, state) => ({ chunks: state.next_chunk_index + 1 }),
  });
  assert.equal(committed.action, 'publish');
  assert.equal(committed.published, true);
  assert.equal(committed.publication.phase, 'published');
});

test('split cycle durably initializes publication then dispatches the Queue', async () => {
  const savedPayloads = [];
  const sent = [];
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
    sendPublication: async (body) => sent.push(body),
  });

  assert.equal(result.task.kind, 'track-history-publish-dispatch');
  assert.equal(savedPayloads.some(({ key }) => key === 'track-history-status'), true);
  assert.equal(savedPayloads.some(({ key }) => key === 'track-history-backfill'), true);
  assert.equal(savedStage.publication.phase, 'rows');
  assert.equal(savedStage.published, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_type, TRACK_HISTORY_PUBLICATION_MESSAGE);
});

test('Queue consumer checkpoints one page before sending its continuation', async () => {
  const operations = [];
  const stage = {
    published: false,
    publication: {
      generation: 'generation-1',
      phase: 'rows',
      rows_written: 0,
      next_chunk_index: 1,
      updated_at: CYCLE_START,
    },
  };
  const result = await processTrackHistoryPublicationTask({ MINUTE_DB: {} }, {
    message_type: TRACK_HISTORY_PUBLICATION_MESSAGE,
    message_version: 1,
    generation: 'generation-1',
  }, {
    now: () => CYCLE_START + 1,
    loadStage: async () => stage,
    advancePublication: async () => ({
      action: 'rows',
      rows: 40,
      chunks: 1,
      published: false,
      publication: { ...stage.publication, rows_written: 40, next_chunk_index: 2, updated_at: CYCLE_START + 1 },
    }),
    saveStage: async () => operations.push('save'),
    sendPublication: async () => operations.push('send'),
  });

  assert.equal(result.rows, 40);
  assert.deepEqual(operations, ['save', 'send']);
});

test('cron window returns to shard scheduling because publication uses Queue invocations', () => {
  assert.equal(pagesReadModelTask(CYCLE_START + 59 * 60_000).kind, 'track-history-step');
  assert.equal(pagesReadModelTask(CYCLE_START + 60 * 60_000).kind, 'idle');
  assert.equal(pagesReadModelTask(CYCLE_START + 175 * 60_000).key, 'minute-facts-current');

  const config = JSON.parse(readFileSync(new URL('../wrangler.pages-read-model.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.vars.PAGES_TRACK_HISTORY_ROWS_PER_STEP, 40);
  assert.equal(config.queues.consumers[0].queue, 'stationhead-pages-read-model-publication');
  assert.equal(config.queues.consumers[0].max_batch_size, 1);
  assert.equal(config.queues.producers[0].binding, 'PAGES_READ_MODEL_QUEUE');
});
