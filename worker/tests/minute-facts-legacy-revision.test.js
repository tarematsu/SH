import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { updatePlaybackState } from '../src/minute-facts-legacy-revision.js';

function createDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE sh_playback_current (
      channel_id INTEGER PRIMARY KEY,
      session_id INTEGER,
      revision_id INTEGER,
      queue_start_time INTEGER,
      is_paused INTEGER,
      paused_total_ms INTEGER,
      pause_started_at INTEGER,
      last_observed_at INTEGER,
      current_position INTEGER
    );
    CREATE TABLE sh_queue_revision_items (
      revision_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      track_id INTEGER,
      duration_ms INTEGER,
      playback_offset_ms INTEGER,
      schedule_valid INTEGER
    );
    CREATE TABLE sh_queue_state_events (
      revision_id INTEGER,
      observed_at INTEGER,
      is_paused INTEGER,
      source TEXT
    );
  `);
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            async first() {
              return statement.get(...params) || null;
            },
            async all() {
              return { results: statement.all(...params) };
            },
            async run() {
              const result = statement.run(...params);
              return { meta: { changes: Number(result.changes || 0) } };
            },
          };
        },
      };
    },
  };
}

test('revision changes within one queue instance preserve pause accumulation', async () => {
  const db = createDatabase();
  const queueStartTime = 1_700_000_000_000;
  db.sqlite.exec(`
    INSERT INTO sh_queue_revision_items VALUES (1,0,101,180000,0,1);
    INSERT INTO sh_queue_revision_items VALUES (2,0,102,180000,0,1);
  `);

  await updatePlaybackState(db, {
    channelId: 10,
    sessionId: 20,
    revisionId: 1,
    queueStartTime,
    observedAt: queueStartTime + 60_000,
    isPaused: true,
  });
  await updatePlaybackState(db, {
    channelId: 10,
    sessionId: 20,
    revisionId: 2,
    queueStartTime,
    observedAt: queueStartTime + 120_000,
    isPaused: true,
  });
  await updatePlaybackState(db, {
    channelId: 10,
    sessionId: 20,
    revisionId: 2,
    queueStartTime,
    observedAt: queueStartTime + 180_000,
    isPaused: false,
  });

  const state = db.sqlite.prepare(`SELECT paused_total_ms,pause_started_at,is_paused
    FROM sh_playback_current WHERE channel_id=10`).get();
  assert.equal(state.paused_total_ms, 120_000);
  assert.equal(state.pause_started_at, null);
  assert.equal(state.is_paused, 0);
});
