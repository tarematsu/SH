import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  queueItemsToWrite,
  queueInspectionDue,
  commentsToWrite,
  planLikeObservations,
} from '../site/functions/api/ingest.js';
import { hostCommentsToWrite } from '../site/functions/api/host-ingest.js';
import {
  LEGACY_SERIES_SQL,
  cachedBroadcastSeries,
  decodeSeriesRows,
  resetBroadcastSeriesCache,
  trimSeries,
} from '../site/functions/api/broadcast-series.js';
import { completeMetadataCount } from '../site/functions/api/track-metadata-refresh.js';
import { cachedSnapshotCount, resetSnapshotCountCache } from '../site/functions/api/health.js';
import { compactProbePayload, officialCommentsToWrite } from '../worker/src/official-news-index.js';

test('unchanged queue items only write when their stored state changes', () => {
  const observedAt = 10_000_000;
  const track = { position: 0, queue_track_id: 11, stationhead_track_id: 22, spotify_id: 'spotify', apple_music_id: 'apple', deezer_id: 'deezer', isrc: 'isrc', duration_ms: 180000, preview_url: 'preview', bite_count: 5, raw: { stable: true } };
  const existing = [{ position: 0, observed_at: observedAt - 1000, queue_id: 7, queue_track_id: 11, stationhead_track_id: 22, spotify_id: 'spotify', apple_music_id: 'apple', deezer_id: 'deezer', isrc: 'isrc', duration_ms: 180000, preview_url: 'preview', bite_count: 5, raw_json: JSON.stringify(track.raw) }];
  assert.equal(queueItemsToWrite([track], existing, observedAt, 7).length, 0);
  assert.equal(queueItemsToWrite([{ ...track, bite_count: 6 }], existing, observedAt, 7).length, 1);
  assert.equal(queueItemsToWrite([track], existing, observedAt + 3_600_000, 7).length, 0);
});

test('hourly queue checkpoints preserve like observations without rewriting queue state', () => {
  const observedAt = 10_000_000;
  const track = { position: 0, queue_track_id: 11, bite_count: 5, raw: { stable: true } };
  const latest = [{ track_key: '11', observed_at: observedAt - 3_600_000, like_count: 5 }];
  assert.equal(planLikeObservations([track], latest, observedAt).length, 1);
});

test('unchanged queue payload skips all item and like inspection between checkpoints', () => {
  const observedAt = 10_000_000;
  const payload = '{"queue_id":7,"tracks":[1]}';
  assert.equal(queueInspectionDue(null, payload, observedAt), true);
  assert.equal(queueInspectionDue({ raw_json: payload, item_observed_at: observedAt - 1000 }, payload, observedAt), false);
  assert.equal(queueInspectionDue({ raw_json: '{"changed":true}', item_observed_at: observedAt - 1000 }, payload, observedAt), true);
  assert.equal(queueInspectionDue({ raw_json: payload, item_observed_at: observedAt - 3_600_000 }, payload, observedAt), true);
});

test('comment filters only return new or changed rows', () => {
  const mainComments = [{ id: 1, raw: { text: 'same' } }, { id: 2, raw: { text: 'changed' } }, { id: 3, raw: { text: 'new' } }];
  assert.deepEqual(commentsToWrite(mainComments, [{ id: 1, raw_json: '{"text":"same"}' }, { id: 2, raw_json: '{"text":"old"}' }]).map((item) => item.id), [2, 3]);
  const hostComments = mainComments.map((item) => ({ comment_id: item.id, raw: item.raw }));
  assert.deepEqual(hostCommentsToWrite(hostComments, [{ comment_id: 1, raw_json: '{"text":"same"}' }, { comment_id: 2, raw_json: '{"text":"old"}' }]).map((item) => item.comment_id), [2, 3]);
});

test('broadcast series calculates event starts in one filtered scan', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sh_legacy_snapshots(id INTEGER PRIMARY KEY,observed_at INTEGER NOT NULL,host_handle TEXT,source_note TEXT,listener_count INTEGER)`);
  const insert = db.prepare('INSERT INTO sh_legacy_snapshots VALUES(?,?,?,?,?)');
  insert.run(1, 1000, 'sakurazaka46jp', 'event-a', null);
  insert.run(2, 2000, 'sakurazaka46jp', 'event-a', 10);
  insert.run(3, 3000, 'sakurazaka46jp', 'event-a', 20);
  insert.run(4, 61000, 'sakurazaka46jp', 'event-a', 30);
  insert.run(5, 121000, 'sakurazaka46jp', 'event-b', 40);
  const rows = db.prepare(LEGACY_SERIES_SQL).all(0, 200000);
  assert.equal(rows.length, 2);
  const decoded = decodeSeriesRows(rows, 'historical_import');
  assert.deepEqual(decoded[0].samples.map((point) => [point.elapsed, point.listener]), [[0, 15], [1, 30]]);
  assert.equal(decoded[0].started_at, 1000);
  assert.equal(decoded[0].samples.reduce((sum, point) => sum + point.sourceSamples, 0), 3);
  assert.equal(decoded[0].sourceTruncated, false);
  const trimmed = trimSeries(decoded, 2);
  assert.equal(trimmed.pointCount, 2);
  assert.equal(trimmed.truncated, true);
});

test('broadcast series cache coalesces concurrent heavy queries', async () => {
  resetBroadcastSeriesCache();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { series: [{ event_name: 'event-a' }] };
  };
  const [first, second] = await Promise.all([
    cachedBroadcastSeries('range-a', loader),
    cachedBroadcastSeries('range-a', loader),
  ]);
  assert.equal(calls, 1);
  assert.strictEqual(first, second);
  assert.strictEqual(await cachedBroadcastSeries('range-a', loader), first);
  assert.equal(calls, 1);
});

test('metadata remaining count only subtracts complete resolutions', () => {
  const resolved = new Map([['a', { title: 'Title', artist: 'Artist' }], ['b', { title: 'Title', artist: '' }], ['c', { title: 'c', artist: 'Artist' }]]);
  assert.equal(completeMetadataCount(resolved), 1);
});

test('snapshot health count is cached and concurrent reads share one query', async () => {
  resetSnapshotCountCache();
  let calls = 0;
  const db = { prepare() { return { async first() { calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { count: 42 }; } }; } };
  const values = await Promise.all([cachedSnapshotCount(db), cachedSnapshotCount(db)]);
  assert.deepEqual(values, [42, 42]);
  assert.equal(calls, 1);
  assert.equal(await cachedSnapshotCount(db), 42);
  assert.equal(calls, 1);
});

test('official news only writes changed announcement comments', () => {
  const announcements = [{ id: 10 }, { id: 20 }];
  const comments = [{ commentId: 1, raw: { text: 'same' } }, { commentId: 2, raw: { text: 'new' } }];
  const rows = officialCommentsToWrite(announcements, comments, [{ announcement_id: 10, comment_id: 1, raw_json: '{"text":"same"}' }, { announcement_id: 20, comment_id: 1, raw_json: '{"text":"same"}' }]);
  assert.deepEqual(rows.map((row) => `${row.announcementId}:${row.comment.commentId}`), ['10:2', '20:2']);
});

test('official probe payload excludes full station and queue bodies', () => {
  const station = { id: 123, is_broadcasting: true, listener_count: 50, huge_unused_field: 'x'.repeat(10000), queue: { id: 9, start_time: 1000, queue_tracks: Array.from({ length: 100 }, (_, index) => ({ id: index, raw: 'x'.repeat(100) })) } };
  const compact = compactProbePayload(station);
  assert.ok(compact.rawJson.length < 1000);
  assert.ok(compact.queueJson.length < 200);
  assert.equal(JSON.parse(compact.queueJson).track_count, 100);
  assert.equal(JSON.parse(compact.rawJson).huge_unused_field, undefined);
});
