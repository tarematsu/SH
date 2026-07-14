import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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

test('worker health responses stay compact', () => {
  const main = readFileSync(
    new URL('../worker/src/main.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(main, /JSON\.stringify\(normalizeHealthPayload\(payload\), null, 2\)/);
});
