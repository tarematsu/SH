import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appleMusicFreeTrackHistoryDatabase,
  withoutAppleMusicTrackHistorySql,
} from '../functions/lib/apple-music-track-history-sql.js';
import { TRACK_HISTORY_SQL as RESTORED_TRACK_HISTORY_SQL } from '../functions/lib/track-history-restored-handler.js';
import { TRACK_HISTORY_SQL } from '../functions/lib/track-history-handler.js';

function placeholderCount(value) {
  return (String(value).match(/\?/g) || []).length;
}

test('track history SQL drops Apple Music comparison, grouping and output fields', () => {
  assert.equal(TRACK_HISTORY_SQL, withoutAppleMusicTrackHistorySql(RESTORED_TRACK_HISTORY_SQL));
  assert.doesNotMatch(TRACK_HISTORY_SQL, /apple_music_id/i);
  assert.equal(placeholderCount(TRACK_HISTORY_SQL), placeholderCount(RESTORED_TRACK_HISTORY_SQL));
  assert.match(TRACK_HISTORY_SQL, /current_first\.spotify_id=previous_item\.spotify_id/);
  assert.match(TRACK_HISTORY_SQL, /UPPER\(current_first\.isrc\)=UPPER\(previous_item\.isrc\)/);
});

test('database adapter rewrites only prepared SQL and preserves methods', async () => {
  let preparedSql = null;
  const db = {
    prepare(sql) {
      preparedSql = sql;
      return { sql };
    },
    marker() { return 7; },
  };
  const wrapped = appleMusicFreeTrackHistoryDatabase(db);
  const statement = wrapped.prepare(RESTORED_TRACK_HISTORY_SQL);
  assert.equal(statement.sql, TRACK_HISTORY_SQL);
  assert.equal(preparedSql, TRACK_HISTORY_SQL);
  assert.equal(wrapped.marker(), 7);
  assert.equal(appleMusicFreeTrackHistoryDatabase(db), wrapped);
});
