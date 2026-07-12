import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROMOTABLE_TIME_UNKNOWN_SQL,
  japaneseHourScheduleTimes,
  promoteJapaneseHourAnnouncements
} from '../src/official-news-japanese-time.js';

test('Japanese hour notation from the real Stationhead announcement is parsed as JST', () => {
  assert.deepEqual(
    japaneseHourScheduleTimes('2025年12月30日(火)20時頃から', 2025),
    [Date.UTC(2025, 11, 30, 11, 0)]
  );
});

test('partial dates and explicit Japanese minutes use the published year', () => {
  assert.deepEqual(
    japaneseHourScheduleTimes('12月30日(火)20時30分頃から開始', 2025),
    [Date.UTC(2025, 11, 30, 11, 30)]
  );
});

test('promotion only reads time-unknown rows after a successful check in this cron', () => {
  assert.match(PROMOTABLE_TIME_UNKNOWN_SQL, /status='time_unknown'/);
  assert.match(PROMOTABLE_TIME_UNKNOWN_SQL, /last_success_at=monitor\.last_check_at/);
  assert.match(PROMOTABLE_TIME_UNKNOWN_SQL, /last_check_at>=\?/);
});

test('a recovered Japanese schedule is upserted while the source row remains available for corrections', async () => {
  const batches = [];
  const prepared = [];
  const row = {
    id: 9,
    news_id: 'R00518',
    news_url: 'https://sakurazaka46.com/s/s46/news/detail/R00518',
    published_date: '2025-12-27',
    title: 'Stationheadリスニングパーティー開催決定！',
    event_name: 'Stationheadリスニングパーティー',
    detected_at: 1000,
    raw_text: '2025年12月30日(火)20時頃から'
  };
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        binds: [],
        bind(...values) {
          this.binds = values;
          return this;
        },
        async all() {
          return { results: [row] };
        }
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ meta: { changes: 1 } }));
    }
  };

  const result = await promoteJapaneseHourAnnouncements(
    { OTHER_DB: db },
    2000,
    3000
  );

  assert.deepEqual(result, { promoted: 1, skipped: false });
  assert.deepEqual(prepared[0].binds, [2000]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
  assert.match(batches[0][0].sql, /INSERT INTO sh_official_news_announcements/);
  assert.match(batches[0][0].sql, /WHERE sh_official_news_announcements\.news_url IS NOT excluded\.news_url/);
  assert.equal(batches[0][0].binds[5], Date.UTC(2025, 11, 30, 11, 0));
  assert.equal(prepared.some((statement) => /status='superseded'/.test(statement.sql)), false);
});
