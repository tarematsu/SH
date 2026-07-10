import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';

import {
  EMAIL_SERIES_CONTEXT_SQL,
  loadEmailSeriesContext,
} from '../worker/src/email-recap-index.js';

function createEmailDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sh_email_stream_snapshots (
    id INTEGER PRIMARY KEY,
    source_key TEXT NOT NULL UNIQUE,
    week_of TEXT NOT NULL,
    stream_count INTEGER NOT NULL
  );
  CREATE INDEX idx_sh_email_stream_snapshots_week
  ON sh_email_stream_snapshots(week_of);`);
  return db;
}

test('email recap validation loads existing, previous and next rows in one query', async () => {
  const db = createEmailDb();
  const insert = db.prepare('INSERT INTO sh_email_stream_snapshots VALUES (?,?,?,?)');
  insert.run(1, 'stationhead-email:2026-06-01', '2026-06-01', 100);
  insert.run(2, 'stationhead-email:2026-06-08', '2026-06-08', 130);
  insert.run(3, 'stationhead-email:2026-06-15', '2026-06-15', 170);
  insert.run(4, 'stationhead-email:2026-06-22', '2026-06-22', 220);

  let prepareCalls = 0;
  let allCalls = 0;
  const wrapper = {
    prepare(sql) {
      prepareCalls += 1;
      assert.equal(sql, EMAIL_SERIES_CONTEXT_SQL);
      const statement = db.prepare(sql);
      return {
        bind(...values) {
          statement.setAllowBareNamedParameters?.(true);
          this.values = values;
          return this;
        },
        async all() {
          allCalls += 1;
          return { results: statement.all(...this.values) };
        },
      };
    },
  };

  const context = await loadEmailSeriesContext(
    wrapper,
    'stationhead-email:2026-06-15',
    '2026-06-15',
  );

  assert.equal(prepareCalls, 1);
  assert.equal(allCalls, 1);
  assert.equal(context.existing.stream_count, 170);
  assert.deepEqual(context.previousRows.map((row) => row.week_of), ['2026-06-01', '2026-06-08']);
  assert.equal(context.next.week_of, '2026-06-22');
});

test('email series context combines all windows in one D1 statement', () => {
  assert.match(EMAIL_SERIES_CONTEXT_SQL, /WITH existing AS/);
  assert.match(EMAIL_SERIES_CONTEXT_SQL, /UNION ALL/);
  assert.equal(
    (EMAIL_SERIES_CONTEXT_SQL.match(/FROM sh_email_stream_snapshots/g) || []).length,
    3,
  );

  const db = createEmailDb();
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${EMAIL_SERIES_CONTEXT_SQL}`)
    .all('source', '2026-06-15', '2026-06-15')
    .map((row) => row.detail)
    .join('\n');
  assert.match(plan, /idx_sh_email_stream_snapshots_week/);
});

test('main chart reuses a prepared model and shares comment velocity values', () => {
  const chart = readFileSync(
    new URL('../site/public/sh-ui-fixes.js', import.meta.url),
    'utf8',
  );

  assert.match(chart, /prepareMainChartModel/);
  assert.match(chart, /mainChartModelSource === rows/);
  assert.match(chart, /commentVelocityValues/);
  assert.match(chart, /commentVelocityMax/);
  assert.match(chart, /drawOnlineChartCachedModel/);
  assert.doesNotMatch(chart, /finiteValues/);
});



test('main chart model skips repeated data preparation for point selection', () => {
  const source = readFileSync(
    new URL('../site/public/sh-ui-fixes.js', import.meta.url),
    'utf8',
  );
  let downsampleCalls = 0;
  const context2d = {
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillText() {}, measureText(text) { return { width: String(text).length * 6 }; },
    save() {}, restore() {}, setLineDash() {}, arc() {}, fill() {},
  };
  const canvas = {
    width: 0, height: 0, clientWidth: 800, style: {},
    getBoundingClientRect() { return { width: 800 }; },
    getContext() { return context2d; },
  };
  const context = {
    Intl, Date, Number, Math,
    window: { devicePixelRatio: 1 },
    document: { documentElement: {} },
    getComputedStyle() { return { getPropertyValue() { return ''; } }; },
    renderPrediction: undefined,
    renderNowDisplay: undefined,
    drawChart() {},
    showMainChartDetail() {},
    lastHistoryRows: [],
    selectedMainChartIndex: null,
    mainChartState: null,
    el(id) { return id === 'chart' ? canvas : null; },
    downsampleRows(rows) { downsampleCalls += 1; return rows; },
    escapeText(value) { return String(value); },
  };
  vm.runInNewContext(source, context);
  const rows = [
    { observed_at: 1000, online_member_count: 10, comment_velocity: 2 },
    { observed_at: 2000, online_member_count: 12, comment_velocity: 4 },
  ];
  context.drawChart(rows, null);
  context.drawChart(rows, 1);
  assert.equal(downsampleCalls, 1);
  assert.deepEqual(Array.from(context.mainChartState.commentVelocityValues), [2, 4]);
  assert.equal(context.mainChartState.commentVelocityMax, 4);
});

test('worker health and recap responses stay compact', () => {
  const recap = readFileSync(
    new URL('../worker/src/email-recap-index.js', import.meta.url),
    'utf8',
  );
  const main = readFileSync(
    new URL('../worker/src/main.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(recap, /JSON\.stringify\(data, null, 2\)/);
  assert.doesNotMatch(main, /JSON\.stringify\(normalizeHealthPayload\(payload\), null, 2\)/);
});
