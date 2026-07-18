import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { pagesReadModelTask } from '../src/pages-read-model-dispatch.js';
import { advanceTrackHistoryPublication } from '../src/pages-track-history-publication.js';
import {
  processTrackHistoryPublicationTask,
  TRACK_HISTORY_PUBLICATION_ACTIONS,
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

function baseStage() {
  return {
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
    completed: { 'recent:0': { sourceRowCount: 3, excludedDates: [] } },
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
  assert.equal(first.rows, 40);
  assert.equal(first.publication.cursor.row_key, 'row-0039');
  assert.ok(written.length >= 1);

  const second = await advanceTrackHistoryPublication({}, first.publication, CYCLE_START + 120_000, {
    loadRows: async () => [row(40)],
    writeChunks: async () => {},
  });
  assert.equal(second.action, 'rows-complete');
  assert.equal(second.publication.phase, 'finalize');

  const committed = await advanceTrackHistoryPublication({}, second.publication, CYCLE_START + 180_000, {
    publishManifest: async (_db, state) => ({ chunks: state.next_chunk_index + 1 }),
  });
  assert.equal(committed.action, 'publish');
  assert.equal(committed.published, true);
});

test('cron checkpoints initialization before dispatching the status Queue stage', async () => {
  const operations = [];
  const sent = [];
  const stage = baseStage();
  const result = await runSplitTrackHistoryCycleStep({ BUDDIES_DB: {}, MINUTE_DB: {} }, CYCLE_START + 12 * 60_000, {
    loadStage: async () => stage,
    saveStage: async () => operations.push('save'),
    sendPublication: async (body) => { operations.push('send'); sent.push(body); },
  });

  assert.equal(result.task.kind, 'track-history-publish-dispatch');
  assert.equal(stage.publication_initializing_at, CYCLE_START + 12 * 60_000);
  assert.equal(stage.publication, undefined);
  assert.deepEqual(operations, ['save', 'send']);
  assert.equal(sent[0].message_type, TRACK_HISTORY_PUBLICATION_MESSAGE);
  assert.equal(sent[0].message_version, 2);
  assert.equal(sent[0].action, TRACK_HISTORY_PUBLICATION_ACTIONS.STATUS);
});

test('status Queue stage checkpoints status before dispatching generation initialization', async () => {
  const operations = [];
  const sent = [];
  const stage = { ...baseStage(), publication_initializing_at: CYCLE_START };
  const status = { generated_at: CYCLE_START + 1, source_row_count: 9 };
  const result = await processTrackHistoryPublicationTask({ MINUTE_DB: {} }, {
    message_type: TRACK_HISTORY_PUBLICATION_MESSAGE,
    message_version: 2,
    action: TRACK_HISTORY_PUBLICATION_ACTIONS.STATUS,
    generation: String(CYCLE_START),
  }, {
    now: () => CYCLE_START + 1,
    loadStage: async () => stage,
    finalizeStatus: async () => status,
    saveStage: async () => operations.push('save'),
    sendPublication: async (body) => { operations.push('send'); sent.push(body); },
  });

  assert.equal(result.action, TRACK_HISTORY_PUBLICATION_ACTIONS.STATUS);
  assert.equal(stage.publication_status, status);
  assert.deepEqual(operations, ['save', 'send']);
  assert.equal(sent[0].action, TRACK_HISTORY_PUBLICATION_ACTIONS.INITIALIZE);
});

test('generation initialization checkpoints the prefix before dispatching the first page', async () => {
  const operations = [];
  const sent = [];
  const stage = {
    ...baseStage(),
    publication_status: { generated_at: CYCLE_START + 1, source_row_count: 9 },
    publication_status_updated_at: CYCLE_START + 1,
  };
  const result = await processTrackHistoryPublicationTask({ MINUTE_DB: {} }, {
    message_type: TRACK_HISTORY_PUBLICATION_MESSAGE,
    message_version: 2,
    action: TRACK_HISTORY_PUBLICATION_ACTIONS.INITIALIZE,
    generation: String(CYCLE_START),
  }, {
    now: () => CYCLE_START + 2,
    loadStage: async () => stage,
    initializePublication: async (_db, publication) => ({ ...publication, prefix_written: true }),
    saveStage: async () => operations.push('save'),
    sendPublication: async (body) => { operations.push('send'); sent.push(body); },
  });

  assert.equal(result.action, TRACK_HISTORY_PUBLICATION_ACTIONS.INITIALIZE);
  assert.equal(stage.publication.prefix_written, true);
  assert.equal(stage.publication_status, undefined);
  assert.deepEqual(operations, ['save', 'send']);
  assert.equal(sent[0].action, TRACK_HISTORY_PUBLICATION_ACTIONS.PAGE);
  assert.equal(sent[0].generation, stage.publication.generation);
});

test('page Queue stage checkpoints one page before sending its continuation', async () => {
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

test('cron keeps lightweight stalled-publication recovery active through minute 174', () => {
  assert.equal(pagesReadModelTask(CYCLE_START + 59 * 60_000).kind, 'track-history-step');
  assert.equal(pagesReadModelTask(CYCLE_START + 60 * 60_000).kind, 'track-history-step');
  assert.equal(pagesReadModelTask(CYCLE_START + 174 * 60_000).kind, 'track-history-step');
  assert.equal(pagesReadModelTask(CYCLE_START + 175 * 60_000).key, 'minute-facts-current');

  const config = JSON.parse(readFileSync(new URL('../wrangler.pages-read-model.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.vars.PAGES_TRACK_HISTORY_ROWS_PER_STEP, 40);
  assert.equal(config.queues.consumers[0].queue, 'stationhead-pages-read-model-publication');
  assert.equal(config.queues.consumers[0].max_batch_size, 1);
  assert.equal(config.queues.producers[0].binding, 'PAGES_READ_MODEL_QUEUE');
});
