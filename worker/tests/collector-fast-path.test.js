import assert from 'node:assert/strict';
import test from 'node:test';

import { collectOptionalComments } from '../src/collector-comments.js';
import { firstDefined } from '../src/collector-config.js';
import { ingest } from '../src/collector-ingest.js';

test('disabled optional comments reuse one immutable resolved promise', async () => {
  const state = { stationId: 42 };
  const config = { chatLimit: 0 };
  const first = collectOptionalComments({}, state, config, 1);
  const second = collectOptionalComments({}, state, config, 2);

  assert.equal(first, second);
  assert.equal(first instanceof Promise, true);
  const result = await first;
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(result, {
    commentsSaved: 0,
    degraded: false,
    errorStage: null,
  });
});

test('firstDefined preserves nullish-only fallback semantics and falsy values', () => {
  assert.equal(firstDefined(undefined, null, 0, 1), 0);
  assert.equal(firstDefined(null, false, true), false);
  assert.equal(firstDefined(undefined, ''), '');
  assert.equal(firstDefined(undefined, null), undefined);
  assert.equal(firstDefined(), undefined);
});

test('unsupported collector writes retain the direct-ingest error without touching D1', async () => {
  let prepares = 0;
  await assert.rejects(
    ingest({
      DB: {
        prepare() {
          prepares += 1;
          throw new Error('unsupported ingest must not prepare D1');
        },
      },
    }, 'unsupported', {}, 1),
    /Direct D1 ingest is unavailable for type=unsupported/,
  );
  assert.equal(prepares, 0);
});
