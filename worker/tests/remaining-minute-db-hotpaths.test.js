import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { resolveTracksAliasFirst } from '../src/minute-track-resolution-optimized.js';

const rollup = readFileSync(new URL('../src/minute-facts-statement-plan.js', import.meta.url), 'utf8');
const playback = readFileSync(new URL('../src/minute-enrichment-playback-stages.js', import.meta.url), 'utf8');
const partialRevision = readFileSync(new URL('../src/minute-partial-revision.js', import.meta.url), 'utf8');
const stagedRevision = readFileSync(new URL('../src/minute-revision-stages.js', import.meta.url), 'utf8');
const deriveTrigger = readFileSync(new URL('../src/minute-derive-trigger.js', import.meta.url), 'utf8');
const readModel = readFileSync(new URL('../src/read-model-stages.js', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../../database/facts-migrations/038_deploy_safe_remaining_hotpaths.sql', import.meta.url),
  'utf8',
);

class Statement {
  constructor(db, sql, bindings = []) {
    this.db = db;
    this.sql = String(sql);
    this.bindings = bindings;
  }

  bind(...bindings) {
    assert.ok(bindings.length <= 80, `D1 query has ${bindings.length} bound parameters`);
    this.db.maxBindings = Math.max(this.db.maxBindings, bindings.length);
    return new Statement(this.db, this.sql, bindings);
  }

  async all() {
    if (this.sql.includes('FROM sh_track_aliases')) {
      this.db.aliasQueries += 1;
      const aliasType = String(this.bindings[0]);
      const results = [];
      for (const aliasValue of this.bindings.slice(1)) {
        const trackId = this.db.aliases.get(`${aliasType}:${String(aliasValue)}`);
        if (trackId != null) {
          results.push({ alias_type: aliasType, alias_value: String(aliasValue), track_id: trackId });
        }
      }
      return { results };
    }
    if (this.sql.includes('FROM sh_track_metadata')) {
      this.db.metadataQueries += 1;
      return { results: [] };
    }
    if (this.sql.includes('FROM sh_tracks')) {
      this.db.identityQueries += 1;
      return {
        results: this.db.identityRows.filter((row) => (
          this.bindings.includes(row.canonical_key)
          || this.bindings.includes(row.isrc)
          || this.bindings.includes(row.spotify_id)
          || this.bindings.includes(row.stationhead_track_id)
        )),
      };
    }
    return { results: [] };
  }
}

class AliasDb {
  constructor(aliases) {
    this.aliases = new Map(aliases);
    this.identityRows = [];
    this.nextTrackId = 1_000;
    this.aliasQueries = 0;
    this.metadataQueries = 0;
    this.identityQueries = 0;
    this.batches = 0;
    this.maxBindings = 0;
    this.maxBatchStatements = 0;
    this.maxBatchBindings = 0;
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements = []) {
    const batchBindings = statements.reduce((total, statement) => total + statement.bindings.length, 0);
    assert.ok(batchBindings <= 80, `D1 batch has ${batchBindings} bound parameters`);
    this.batches += 1;
    this.maxBatchStatements = Math.max(this.maxBatchStatements, statements.length);
    this.maxBatchBindings = Math.max(this.maxBatchBindings, batchBindings);
    for (const statement of statements) {
      if (!statement.sql.includes('INSERT OR IGNORE INTO sh_tracks')) continue;
      const [canonical_key, isrc, spotify_id, stationhead_track_id] = statement.bindings;
      if (this.identityRows.some((row) => row.canonical_key === canonical_key)) continue;
      this.identityRows.push({
        id: this.nextTrackId,
        canonical_key,
        isrc,
        spotify_id,
        stationhead_track_id,
      });
      this.nextTrackId += 1;
    }
    return [];
  }
}

test('known queue tracks resolve through bounded indexed alias queries without metadata or direct track scans', async () => {
  const db = new AliasDb([
    ['isrc:JPTEST000001', 11],
    ['spotify_id:spotify-2', 12],
  ]);
  const tracks = await resolveTracksAliasFirst(db, null, [
    { position: 0, isrc: 'JPTEST000001', spotify_id: 'spotify-1', duration_ms: 180_000 },
    { position: 1, spotify_id: 'spotify-2', duration_ms: 180_000 },
  ], 1_000);

  assert.deepEqual(tracks.map(({ trackId }) => trackId), [11, 12]);
  assert.equal(db.aliasQueries, 2);
  assert.equal(db.metadataQueries, 0);
  assert.equal(db.identityQueries, 0);
});

test('track resolution bounds individual statements and aggregate batch bindings', async () => {
  const db = new AliasDb([]);
  const input = Array.from({ length: 30 }, (_, index) => ({
    position: index,
    isrc: `JPTEST${String(index + 1).padStart(6, '0')}`,
    spotify_id: `spotify-${index + 1}`,
    stationhead_track_id: 10_000 + index,
    legacy_track_id: 20_000 + index,
    title: `Title ${index + 1}`,
    artist: `Artist ${index + 1}`,
    duration_ms: 180_000,
  }));

  const tracks = await resolveTracksAliasFirst(db, null, input, 1_000);

  assert.equal(tracks.length, 30);
  assert.ok(tracks.every(({ trackId }) => trackId != null));
  assert.equal(db.aliasQueries, 10);
  assert.equal(db.metadataQueries, 1);
  assert.equal(db.identityQueries, 2);
  assert.equal(db.maxBindings, 80);
  assert.equal(db.batches, 20);
  assert.equal(db.maxBatchStatements, 13);
  assert.equal(db.maxBatchBindings, 80);
});

test('track resolution reports the failing D1 substage', async () => {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async all() {
              throw new Error('D1_ERROR: Wrong number of parameter bindings for SQL query.');
            },
          };
        },
      };
    },
  };

  await assert.rejects(
    resolveTracksAliasFirst(db, null, [{ isrc: 'JPTEST000001' }], 1_000),
    /load_alias_map_initial: D1_ERROR: Wrong number of parameter bindings/,
  );
});

test('dashboard rollup seeks the current and previous minute rather than rescanning a bucket', () => {
  assert.match(rollup, /current_fact/);
  assert.match(rollup, /previous\.minute_at>=f\.minute_at-60000/);
  assert.match(rollup, /INDEXED BY idx_sh_minute_facts_source_channel_minute_desc/);
  assert.doesNotMatch(rollup, /RANGE BETWEEN|ROW_NUMBER\(\)|MAX\(comment_velocity\) OVER/);
});

test('playback patch writes finalized position on the fact row only', () => {
  assert.match(playback, /queue_position_patch=\?/);
  assert.doesNotMatch(playback, /UPDATE sh_minute_fact_context_v2 SET queue_position/);
  assert.doesNotMatch(playback, /db\.batch\(\[\s*db\.prepare\(`UPDATE sh_minute_facts/);
  assert.match(migration, /COALESCE\(f\.queue_position_patch,v\.queue_position\)/);
});

test('revision lookup and staged progress avoid item COUNT scans', () => {
  assert.match(partialRevision, /COALESCE\(r\.materialized_item_count,0\)/);
  assert.doesNotMatch(partialRevision, /SELECT COUNT\(\*\).*sh_queue_revision_items/s);
  assert.match(stagedRevision, /ORDER BY position DESC\s+LIMIT 1/);
  assert.doesNotMatch(stagedRevision, /SELECT COUNT\(\*\).*sh_queue_revision_items/s);
});

test('derive recovery and channel read models use bounded semantic paths', () => {
  assert.match(deriveTrigger, /INDEXED BY idx_sh_minute_fact_jobs_pending_ready/);
  assert.match(deriveTrigger, /ORDER BY next_attempt_at ASC,job_priority DESC/);
  assert.match(migration, /ON sh_minute_fact_jobs\(next_attempt_at ASC,job_priority DESC,minute_at ASC,id ASC\)/);
  assert.doesNotMatch(migration, /INSERT|FROM sh_tracks/);
  assert.match(readModel, /stableChannelPresentation/);
  assert.match(readModel, /current_stream_count: _ignored/);
  const channelWrite = readModel.match(/INSERT INTO sh_channel_read_model[\s\S]*?\.bind\(channelId, observedAt, presentationJson\)/)?.[0] || '';
  assert.doesNotMatch(channelWrite, /READ_MODEL_CHECKPOINT_MS/);
});
