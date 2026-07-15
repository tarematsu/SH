import assert from 'node:assert/strict';
import test from 'node:test';

import {
  metadataIdentityBySpotifyId,
  refreshMissingMetadata,
} from '../site/functions/lib/track-history-metadata.js';

test('history metadata identities normalize ISRC and prefer a known value', () => {
  const identities = metadataIdentityBySpotifyId([
    { spotify_id: 123, isrc: null },
    { spotify_id: '123', isrc: ' jpabc2600001 ' },
  ]);
  assert.equal(identities.get('123'), 'JPABC2600001');
});

test('history Spotify repair persists the row ISRC', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  });
  globalThis.caches = undefined;
  globalThis.fetch = async () => new Response(JSON.stringify({
    title: 'Song - song and lyrics by Artist',
    author_name: 'Artist',
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const calls = [];
  const DB = {
    prepare(sql) {
      return {
        sql,
        params: [],
        bind(...params) { this.params = params; return this; },
      };
    },
    async batch(statements) {
      calls.push(...statements);
      return statements.map(() => ({ success: true }));
    },
  };

  const persisted = await refreshMissingMetadata([{
    spotify_id: 123,
    isrc: ' jpabc2600001 ',
    title: null,
    artist: null,
  }], { DB });

  assert.equal(persisted, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /spotify_id,isrc,title,artist/);
  assert.deepEqual(calls[0].params.slice(0, 4), [
    '123',
    'JPABC2600001',
    'Song',
    'Artist',
  ]);
  assert.match(calls[0].params[7], /"isrc":"JPABC2600001"/);
});
