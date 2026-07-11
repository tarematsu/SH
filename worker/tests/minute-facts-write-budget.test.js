import assert from 'node:assert/strict';
import test from 'node:test';
import { saveMinuteFactWithinBudget, withAbortableMinuteFactD1 } from '../src/minute-facts-write-budget.js';

test('minute fact D1 remains guarded after bind', async () => {
  const controller = new AbortController();
  const db = { prepare() { return { bind() { return this; }, async run() { controller.abort(new Error('deadline')); return {}; } }; } };
  await assert.rejects(withAbortableMinuteFactD1(db, controller.signal).prepare('x').bind().run(), /deadline/);
});

test('minute fact batch checks abort after completion', async () => {
  const controller = new AbortController();
  const db = { async batch() { controller.abort(new Error('batch deadline')); return []; } };
  await assert.rejects(withAbortableMinuteFactD1(db, controller.signal).batch([]), /batch deadline/);
});

test('minute fact write rejects an already aborted signal', async () => {
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  await assert.rejects(saveMinuteFactWithinBudget({ __COLLECTION_ABORT_SIGNAL: controller.signal }, {}, async () => ({ ok: true })), /already cancelled/);
});
