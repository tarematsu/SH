import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { runBuddyPlaybackQueue } from '../src/buddy-playback-entry.js';

test('buddy playback parse logging never serializes the carried prepared payload', async () => {
  const sent = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (value) => logs.push(String(value));
  try {
    const calls = [];
    await runBuddyPlaybackQueue({
      messages: [{
        body: {
          message_type: 'buddy-playback-stage',
          message_version: 1,
          scheduled_at: 1_800_000,
          observed_at: 1_800_123,
        },
        ack() { calls.push('ack'); },
        retry() { calls.push('retry'); },
      }],
    }, {
      BUDDY_PLAYBACK_QUEUE: {
        async send(body, options) { sent.push({ body, options }); },
      },
    }, {
      advance: async () => ({
        pending: true,
        stage: 'parse-store',
        cycle_at: 1_800_000,
        prepared_parse: { queue: { tracks: [{ title: 'must-not-appear-in-log' }] } },
      }),
    });

    assert.deepEqual(calls, ['ack']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.prepared_parse.queue.tracks.length, 1);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0], /prepared_parse|must-not-appear-in-log/);
    assert.match(logs[0], /"stage":"parse-store"/);
  } finally {
    console.log = originalLog;
  }
});

test('buddy playback Queue entry uses one-message dispatch and frozen options', () => {
  const source = readFileSync(new URL('../src/buddy-playback-entry.js', import.meta.url), 'utf8');
  assert.match(source, /const NEXT_STAGE_OPTIONS = Object\.freeze/);
  assert.match(source, /const RETRY_60_SECONDS = Object\.freeze/);
  assert.match(source, /const message = messages\[0\]/);
  assert.match(source, /function logBuddyPlaybackResult/);
  assert.doesNotMatch(source, /for \(const message of batch/);
  assert.doesNotMatch(source, /buddy_playback_stage_completed', \.\.\.result/);
});
