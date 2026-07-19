import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  OFFICIAL_NEWS_STAGE_MESSAGE,
  officialNewsStageTask,
  processOfficialNewsStage,
} from '../src/other-official-news-stages.js';

const BASE = Date.UTC(2026, 0, 1, 0, 20, 0);
const CANDIDATES = [
  { newsId: 'a', href: 'https://example.com/a', listTitle: 'A' },
  { newsId: 'b', href: 'https://example.com/b', listTitle: 'B' },
];

function messageStage(stage, extra = {}) {
  return {
    message_type: OFFICIAL_NEWS_STAGE_MESSAGE,
    message_version: 1,
    stage,
    scheduled_at: BASE,
    ...extra,
  };
}

test('legacy probe stage performs only the list scan and queues the first detail', async () => {
  const sent = [];
  const result = await processOfficialNewsStage({}, {
    stage: 'probe',
    scheduledAt: BASE,
    candidates: [],
    candidateIndex: 0,
  }, {
    config: () => ({ marker: 'config' }),
    list: async (_env, config, now) => {
      assert.equal(config.marker, 'config');
      assert.equal(now, BASE);
      return { skipped: false, failed: false, candidates: CANDIDATES };
    },
    send: async (message) => sent.push(message),
  });

  assert.equal(result.stage, 'probe');
  assert.equal(result.next_stage, 'news-detail');
  assert.equal(result.candidates, 2);
  assert.equal(sent[0].stage, 'news-detail');
  assert.equal(sent[0].candidate_index, 0);
  assert.deepEqual(sent[0].candidates, CANDIDATES);
});

test('not-due list result goes directly to station probe without recording completion', async () => {
  const sent = [];
  const result = await processOfficialNewsStage({}, {
    stage: 'probe',
    scheduledAt: BASE,
  }, {
    config: () => ({}),
    list: async () => ({ skipped: true, failed: false, reason: 'not-due', candidates: [] }),
    send: async (message) => sent.push(message),
  });
  assert.equal(result.next_stage, 'station-probe');
  assert.equal(sent[0].stage, 'station-probe');
});

test('list failure continues to station probe but never marks a successful check', async () => {
  const sent = [];
  const result = await processOfficialNewsStage({}, {
    stage: 'probe',
    scheduledAt: BASE,
  }, {
    config: () => ({}),
    list: async () => ({ skipped: true, failed: true, reason: 'official_news_list_failed' }),
    send: async (message) => sent.push(message),
  });
  assert.equal(result.next_stage, 'station-probe');
  assert.equal(sent[0].stage, 'station-probe');
});

test('detail stage processes one candidate and queues the next candidate', async () => {
  const sent = [];
  const result = await processOfficialNewsStage({}, {
    stage: 'news-detail',
    scheduledAt: BASE,
    candidates: CANDIDATES,
    candidateIndex: 0,
  }, {
    config: () => ({}),
    detail: async (_env, _config, now, candidate) => {
      assert.equal(now, BASE);
      assert.equal(candidate.newsId, 'a');
      return { skipped: false, failed: false, saved: 1 };
    },
    send: async (message) => sent.push(message),
  });
  assert.equal(result.next_stage, 'news-detail');
  assert.equal(result.saved, 1);
  assert.equal(sent[0].candidate_index, 1);
  assert.deepEqual(sent[0].candidates, CANDIDATES);
});

test('final detail queues check completion', async () => {
  const sent = [];
  const result = await processOfficialNewsStage({}, {
    stage: 'news-detail',
    scheduledAt: BASE,
    candidates: CANDIDATES,
    candidateIndex: 1,
  }, {
    config: () => ({}),
    detail: async () => ({ skipped: true, failed: false, reason: 'not-stationhead', saved: 0 }),
    send: async (message) => sent.push(message),
  });
  assert.equal(result.next_stage, 'news-complete');
  assert.equal(sent[0].stage, 'news-complete');
});

test('detail failure skips completion and continues to station probe', async () => {
  const sent = [];
  const result = await processOfficialNewsStage({}, {
    stage: 'news-detail',
    scheduledAt: BASE,
    candidates: CANDIDATES,
    candidateIndex: 0,
  }, {
    config: () => ({}),
    detail: async () => ({ skipped: true, failed: true, reason: 'official_news_detail_failed' }),
    send: async (message) => sent.push(message),
  });
  assert.equal(result.next_stage, 'station-probe');
  assert.equal(sent[0].stage, 'station-probe');
});

test('check completion records success before station probe', async () => {
  const order = [];
  const result = await processOfficialNewsStage({}, {
    stage: 'news-complete',
    scheduledAt: BASE,
  }, {
    complete: async (_env, now) => {
      order.push(['complete', now]);
      return { skipped: false };
    },
    send: async (message) => order.push(['send', message.stage]),
  });
  assert.equal(result.next_stage, 'station-probe');
  assert.deepEqual(order, [['complete', BASE], ['send', 'station-probe']]);
});

test('station probe is independent and queues reconciliation', async () => {
  const sent = [];
  const result = await processOfficialNewsStage({}, {
    stage: 'station-probe',
    scheduledAt: BASE,
  }, {
    config: () => ({}),
    probe: async () => ({ skipped: false }),
    send: async (message) => sent.push(message),
  });
  assert.equal(result.stage, 'station-probe');
  assert.equal(result.next_stage, 'reconcile');
  assert.equal(sent[0].stage, 'reconcile');
});

test('official-news reconciliation is an independent stage', async () => {
  const calls = [];
  const result = await processOfficialNewsStage({ marker: true }, {
    stage: 'reconcile',
    scheduledAt: BASE,
  }, {
    reconcile: async (env, now) => calls.push([env, now]),
  });
  assert.equal(result.stage, 'reconcile');
  assert.equal(result.pending, false);
  assert.equal(calls[0][0].marker, true);
  assert.equal(calls[0][1], BASE);
});

test('task validation bounds candidate payloads and preserves rollout stages', () => {
  assert.deepEqual(officialNewsStageTask(messageStage('probe')), {
    stage: 'probe', scheduledAt: BASE, candidates: [], candidateIndex: 0,
  });
  assert.deepEqual(officialNewsStageTask(messageStage('news-detail', {
    candidates: CANDIDATES,
    candidate_index: 1,
  })), {
    stage: 'news-detail', scheduledAt: BASE, candidates: CANDIDATES, candidateIndex: 1,
  });
  assert.equal(officialNewsStageTask(messageStage('news-complete')).stage, 'news-complete');
  assert.equal(officialNewsStageTask(messageStage('station-probe')).stage, 'station-probe');
  assert.equal(officialNewsStageTask(messageStage('reconcile')).stage, 'reconcile');

  const source = readFileSync(new URL('../src/other-monitor-entry.js', import.meta.url), 'utf8');
  assert.match(source, /messageType === OFFICIAL_NEWS_STAGE_MESSAGE/);
  assert.match(source, /processOfficialNewsStageMessage/);
  assert.match(source, /const message = messages\[0\]/);
});
