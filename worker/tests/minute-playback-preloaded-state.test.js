import assert from 'node:assert/strict';
import test from 'node:test';

import { processMinutePlaybackResolve } from '../src/minute-enrichment-playback-stages.js';
import { updatePlaybackState } from '../src/minute-facts-legacy-revision.js';

function body() {
  return {
    message_type: 'minute-fact-enrichment',
    message_version: 1,
    stage: 'playback',
    channel_id: 10,
    station_id: 20,
    minute_at: 120_000,
    observed_at: 125_000,
    provisional_session_id: 25,
    revision_id: 30,
    queue_start_time: 100_000,
    is_paused: false,
    queue: { tracks: [] },
  };
}

test('playback resolve loads winner and previous playback state in one D1 query', async () => {
  const task = body();
  const prepared = [];
  let updateInput = null;
  const db = {
    prepare(sql) {
      prepared.push(sql);
      assert.match(sql, /LEFT JOIN sh_playback_current/);
      return {
        bind(channelId, minuteAt) {
          assert.equal(channelId, task.channel_id);
          assert.equal(minuteAt, task.minute_at);
          return this;
        },
        async first() {
          return {
            observed_at: task.observed_at,
            playback_channel_id: task.channel_id,
            playback_session_id: 24,
            playback_revision_id: 29,
            playback_queue_start_time: 90_000,
            playback_is_paused: 0,
            playback_paused_total_ms: 1_000,
            playback_pause_started_at: null,
            playback_last_observed_at: 124_000,
            playback_current_position: 2,
          };
        },
      };
    },
  };

  const result = await processMinutePlaybackResolve({ MINUTE_DB: db }, task, {
    async updatePlaybackState(_db, input) {
      updateInput = input;
      return {
        current_position: 3,
        current_track_id: 300,
        current_schedule_valid: 1,
      };
    },
    async sendStage() {},
  });

  assert.equal(prepared.length, 1);
  assert.deepEqual(updateInput.previous, {
    channel_id: 10,
    session_id: 24,
    revision_id: 29,
    queue_start_time: 90_000,
    is_paused: 0,
    paused_total_ms: 1_000,
    pause_started_at: null,
    last_observed_at: 124_000,
    current_position: 2,
  });
  assert.equal(result.pending, true);
});

test('preloaded playback state avoids the legacy state read', async () => {
  const previous = {
    channel_id: 10,
    last_observed_at: 126_000,
    current_position: 4,
  };
  const db = new Proxy({}, {
    get() {
      assert.fail('delayed preloaded playback must not access D1');
    },
  });

  const result = await updatePlaybackState(db, {
    channelId: 10,
    sessionId: 20,
    revisionId: 30,
    queueStartTime: 100_000,
    observedAt: 125_000,
    isPaused: false,
    previous,
  });

  assert.equal(result.delayed, true);
  assert.equal(result.current_position, null);
  assert.equal(result.last_observed_at, previous.last_observed_at);
});
