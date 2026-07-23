import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensureRevisionR2Progress,
  revisionProgressObjectKey,
  writeRevisionR2ProgressChunk,
} from '../src/minute-revision-r2-progress.js';

class MemoryR2 {
  constructor() {
    this.values = new Map();
    this.puts = [];
  }

  async put(key, body) {
    this.values.set(key, String(body));
    this.puts.push(key);
  }

  async get(key) {
    const body = this.values.get(key);
    if (body == null) return null;
    return {
      async json() { return JSON.parse(body); },
      async text() { return body; },
    };
  }

  payload(key) {
    return JSON.parse(this.values.get(key));
  }
}

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new Statement(this.db, this.sql, args);
  }

  async run() {
    this.db.runs.push({ sql: this.sql, args: this.args });
    return { meta: { changes: 1 } };
  }
}

class RecordingDb {
  constructor() {
    this.batches = [];
    this.runs = [];
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    this.batches.push(statements.map((statement) => ({
      sql: statement.sql,
      args: statement.args,
    })));
    return statements.map(() => ({ success: true, meta: { changes: 1 } }));
  }
}

const revision = {
  sparse: true,
  rebuild: true,
  revision_id: 7,
  source_job_id: 3,
  visible_item_count: 2,
  total_item_count: 2,
  preferred_position: 0,
  enrichment: {
    channel_id: 10,
    minute_at: 120_000,
    observed_at: 125_000,
  },
};

const tracks = [
  {
    position: 0,
    queue_track_id: 20,
    stationhead_track_id: 100,
    spotify_id: 'sp-0',
    isrc: 'JPTEST0',
    duration_ms: 180_000,
    bite_count: 2,
  },
  {
    position: 1,
    queue_track_id: 21,
    stationhead_track_id: 101,
    spotify_id: 'sp-1',
    isrc: 'JPTEST1',
    duration_ms: 200_000,
    bite_count: 3,
  },
];

function resolver(_db, _fallback, selected) {
  return selected.map((track) => ({
    ...track,
    trackId: 1000 + track.position,
  }));
}

test('revision progress stays in R2 until one final D1 commit', async () => {
  const r2 = new MemoryR2();
  const db = new RecordingDb();
  const env = {
    REVISION_PROGRESS_R2_ENABLED: true,
    DERIVE_REVISION_CHUNK_TRACKS: 1,
    PAGES_RESPONSE_R2: r2,
    MINUTE_DB: db,
  };

  const ensured = await ensureRevisionR2Progress(env, revision, tracks, {
    materializedItemCount: 0,
    now: 100_000,
  });
  assert.equal(ensured.enabled, true);
  assert.equal(ensured.key, revisionProgressObjectKey(7));
  assert.equal(r2.payload(ensured.key).items.length, 0);

  const first = await writeRevisionR2ProgressChunk(env, {
    ...revision,
    r2_progress: true,
  }, { resolveTracksBulk: resolver });
  assert.equal(first.complete, false);
  assert.equal(first.storage, 'r2-progress');
  assert.equal(first.materialized_item_count, 1);
  assert.equal(first.chunk_tracks, 1);
  assert.equal(db.batches.length, 0);
  assert.equal(db.runs.length, 0);

  const second = await writeRevisionR2ProgressChunk(env, {
    ...revision,
    r2_progress: true,
    materialized_item_count: 1,
  }, { resolveTracksBulk: resolver });
  assert.equal(second.complete, true);
  assert.equal(second.storage, 'd1-final');
  assert.equal(second.materialized_item_count, 2);
  assert.equal(second.chunk_tracks, 1);
  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, 2);
  assert.ok(db.batches[0].every(({ sql }) => sql.includes('INSERT INTO sh_queue_revision_items')));
  assert.equal(db.runs.length, 1);
  assert.match(db.runs[0].sql, /UPDATE sh_queue_revisions SET/);
  assert.deepEqual(db.runs[0].args.slice(0, 2), [2, 1]);

  const committed = r2.payload(revisionProgressObjectKey(7));
  assert.equal(committed.items.length, 2);
  assert.equal(Number.isFinite(committed.committed_at), true);

  const replay = await writeRevisionR2ProgressChunk(env, {
    ...revision,
    r2_progress: true,
    materialized_item_count: 2,
  }, { resolveTracksBulk: resolver });
  assert.equal(replay.complete, true);
  assert.equal(replay.storage, 'r2-committed');
  assert.equal(replay.chunk_tracks, 0);
  assert.equal(db.batches.length, 1);
  assert.equal(db.runs.length, 1);
});

test('existing partial D1 revision progress stays on the legacy fallback path', async () => {
  const result = await ensureRevisionR2Progress({
    REVISION_PROGRESS_R2_ENABLED: true,
    PAGES_RESPONSE_R2: new MemoryR2(),
  }, revision, tracks, { materializedItemCount: 1 });
  assert.deepEqual(result, { enabled: false, reason: 'd1-progress-exists' });
});
