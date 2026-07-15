import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enrichIsrcTracks,
  musicBrainzRecordingMetadata,
  normalizeIsrc,
} from '../src/isrc-metadata.js';

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new Statement(this.db, this.sql, args);
  }

  async all() {
    if (this.sql.includes('FROM sh_isrc_metadata')) {
      return { results: [...this.db.metadata.values()].filter((row) => this.args.includes(row.isrc)) };
    }
    return { results: [] };
  }

  async run() {
    if (this.sql.includes('INSERT INTO sh_isrc_metadata')) {
      const [isrc, title, artist, source, fetchedAt, rawJson] = this.args;
      this.db.metadata.set(isrc, {
        isrc,
        title,
        artist,
        source,
        fetched_at: fetchedAt,
        raw_json: rawJson,
      });
    }
    if (this.sql.includes('UPDATE sh_tracks SET')) {
      this.db.trackUpdates.push(this.args);
    }
    return { meta: { changes: 1 } };
  }
}

class FakeDb {
  constructor() {
    this.metadata = new Map();
    this.trackUpdates = [];
  }

  prepare(sql) {
    return new Statement(this, sql);
  }
}

test('ISRC normalization removes separators and rejects malformed values', () => {
  assert.equal(normalizeIsrc('jp-sr0-26-00001'), 'JPSR02600001');
  assert.equal(normalizeIsrc('not-an-isrc'), null);
});

test('MusicBrainz response becomes title and artist metadata', () => {
  const metadata = musicBrainzRecordingMetadata({
    recordings: [{
      id: 'recording-1',
      title: 'Test Song',
      'artist-credit': [{ name: 'Artist A' }, { name: 'Artist B' }],
    }],
  }, 'JPSR02600001', 1234);

  assert.deepEqual(metadata, {
    isrc: 'JPSR02600001',
    title: 'Test Song',
    artist: 'Artist A & Artist B',
    source: 'musicbrainz',
    fetched_at: 1234,
    raw_json: JSON.stringify({ recording_id: 'recording-1' }),
  });
});

test('ISRC enrichment is disabled unless the minute worker enables it', async () => {
  const db = new FakeDb();
  const result = await enrichIsrcTracks({ MINUTE_DB: db }, {
    tracks: [{ isrc: 'JPSR02600001' }],
  }, {});

  assert.deepEqual(result, { saved: 0, attempted: 0 });
  assert.equal(db.metadata.size, 0);
});

test('ISRC enrichment persists one lookup and applies it to matching tracks', async () => {
  const db = new FakeDb();
  const result = await enrichIsrcTracks({ MINUTE_DB: db, ISRC_METADATA_LIMIT: 1 }, {
    tracks: [
      { isrc: 'JP-SR0-26-00001' },
      { isrc: 'JP-SR0-26-00002' },
    ],
  }, {}, {
    fetchMetadata: async (isrc) => ({
      isrc,
      title: 'Resolved Song',
      artist: 'Resolved Artist',
      source: 'musicbrainz',
      fetched_at: 2000,
      raw_json: '{}',
    }),
  });

  assert.deepEqual(result, { saved: 1, attempted: 1 });
  assert.equal(db.metadata.size, 1);
  assert.deepEqual(db.trackUpdates[0], ['Resolved Song', 'Resolved Artist', 'JPSR02600001']);
});
