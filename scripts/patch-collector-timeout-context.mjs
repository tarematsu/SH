import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(path, before, after) {
  const source = readFileSync(path, 'utf8');
  if (!source.includes(before)) throw new Error(`Expected block not found in ${path}`);
  const updated = source.replace(before, after);
  if (updated === source) throw new Error(`No replacement made in ${path}`);
  writeFileSync(path, updated);
}

replaceOnce(
  'worker/src/collector-runner.js',
  `let collectionFlight = null;\n\n`,
  '',
);

replaceOnce(
  'worker/src/collector-runner.js',
  `export function runCollection(env, source = 'manual', collector = collectOnce) {\n  if (collectionFlight) return collectionFlight;\n  collectionFlight = Promise.resolve()\n    .then(() => collector(env, source))\n    .finally(() => { collectionFlight = null; });\n  return collectionFlight;\n}\n\nexport function resetCollectionFlight() {\n  collectionFlight = null;\n}\n`,
  `export function runCollection(env, source = 'manual', collector = collectOnce) {\n  return Promise.resolve().then(() => collector(env, source));\n}\n\nexport function resetCollectionFlight() {\n  // Kept as a compatibility no-op for callers and tests. Collection promises are\n  // request-scoped and must never be shared across Cloudflare request contexts.\n}\n`,
);

const schedulerPath = 'worker/src/main-scheduler.js';
const scheduler = readFileSync(schedulerPath, 'utf8');
const schedulerStart = scheduler.indexOf('let primaryScheduledFlight = null;');
const schedulerEnd = scheduler.indexOf('export function resetPrimaryScheduledFlightForTests()');
if (schedulerStart < 0 || schedulerEnd < 0) throw new Error('main scheduler shared-flight block not found');
const withoutSharedFlight = `${scheduler.slice(0, schedulerStart)}${scheduler.slice(schedulerEnd)}`;
let nextScheduler = withoutSharedFlight.replace(
  `export function resetPrimaryScheduledFlightForTests() {\n  primaryScheduledFlight = null;\n}\n`,
  `export function resetPrimaryScheduledFlightForTests() {\n  // Compatibility no-op. Scheduled promises are request-scoped.\n}\n`,
);
const runStart = nextScheduler.indexOf('export async function runPrimaryScheduled(');
if (runStart < 0) throw new Error('runPrimaryScheduled not found');
nextScheduler = `${nextScheduler.slice(0, runStart)}export async function runPrimaryScheduled(\n  controller,\n  env,\n  ctx,\n  scheduled = app.scheduled.bind(app),\n  timeoutOverride = null,\n  options = {},\n) {\n  const timeoutMs = timeoutOverride ?? primaryWatchdogMs(env);\n  const flight = {\n    primary: Promise.resolve().then(() => scheduled(controller, env, ctx)),\n  };\n  let timeoutId = null;\n\n  try {\n    const result = await Promise.race([\n      flight.primary,\n      new Promise((_, reject) => {\n        timeoutId = setTimeout(() => {\n          options.resetCollectionFlight?.();\n          reject(new PrimaryCollectionTimeoutError(timeoutMs, controller?.cron));\n        }, timeoutMs);\n      }),\n    ]);\n    const auxiliary = startAuxiliaryOnce(\n      flight, env, false, options.auxiliaryRunners || DEFAULT_AUXILIARY_RUNNERS,\n    );\n    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(auxiliary);\n    else await auxiliary;\n    return result;\n  } catch (error) {\n    const auxiliary = startAuxiliaryOnce(\n      flight, env, true, options.auxiliaryRunners || DEFAULT_AUXILIARY_RUNNERS,\n    );\n    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(auxiliary);\n    else await auxiliary;\n    throw error;\n  } finally {\n    if (timeoutId != null) clearTimeout(timeoutId);\n  }\n}\n`;
writeFileSync(schedulerPath, nextScheduler);

replaceOnce(
  'worker/src/optimized-index.js',
  `import { ensureAuthControlRow, readAuthState } from './auth-state.js';\n`,
  `import { ensureAuthControlRow, readAuthState } from './auth-state.js';\nimport { combinedAbortSignal } from './request-signal.js';\n`,
);

replaceOnce(
  'worker/src/optimized-index.js',
  `        signal: AbortSignal.timeout(15_000),\n`,
  `        signal: combinedAbortSignal(init.signal, 15_000),\n`,
);

writeFileSync('worker/src/request-signal.js', `export function combinedAbortSignal(existingSignal, timeoutMs) {\n  const timeoutSignal = AbortSignal.timeout(timeoutMs);\n  if (!existingSignal) return timeoutSignal;\n  if (typeof AbortSignal.any === 'function') {\n    return AbortSignal.any([existingSignal, timeoutSignal]);\n  }\n  return existingSignal;\n}\n`);

writeFileSync('worker/tests/collector-timeout-context.test.js', `import assert from 'node:assert/strict';\nimport test from 'node:test';\n\nimport { runCollection } from '../src/collector-runner.js';\nimport {\n  PrimaryCollectionTimeoutError,\n  runPrimaryScheduled,\n} from '../src/main-scheduler.js';\nimport { combinedAbortSignal } from '../src/request-signal.js';\n\nfunction context() {\n  const tasks = [];\n  return {\n    tasks,\n    waitUntil(task) { tasks.push(Promise.resolve(task)); },\n  };\n}\n\ntest('concurrent cron invocations do not reuse a promise from another request context', async () => {\n  const resolvers = [];\n  let calls = 0;\n  const scheduled = () => {\n    calls += 1;\n    return new Promise((resolve) => resolvers.push(resolve));\n  };\n  const firstContext = context();\n  const secondContext = context();\n  const first = runPrimaryScheduled(\n    { cron: '* * * * *' }, {}, firstContext, scheduled, 1_000, { auxiliaryRunners: {} },\n  );\n  const second = runPrimaryScheduled(\n    { cron: '* * * * *' }, {}, secondContext, scheduled, 1_000, { auxiliaryRunners: {} },\n  );\n  await Promise.resolve();\n  assert.equal(calls, 2);\n  resolvers[0]({ run: 1 });\n  resolvers[1]({ run: 2 });\n  assert.deepEqual(await Promise.all([first, second]), [{ run: 1 }, { run: 2 }]);\n  await Promise.all([...firstContext.tasks, ...secondContext.tasks]);\n});\n\ntest('timeout resets only the request-local collector and reports a timeout', async () => {\n  let resets = 0;\n  await assert.rejects(\n    runPrimaryScheduled(\n      { cron: '* * * * *' },\n      {},\n      context(),\n      () => new Promise(() => {}),\n      10,\n      { auxiliaryRunners: {}, resetCollectionFlight: () => { resets += 1; } },\n    ),\n    (error) => error instanceof PrimaryCollectionTimeoutError && error.timeoutMs === 10,\n  );\n  assert.equal(resets, 1);\n});\n\ntest('collector calls are never deduplicated through a module-level promise', async () => {\n  const resolvers = [];\n  let calls = 0;\n  const collector = () => {\n    calls += 1;\n    return new Promise((resolve) => resolvers.push(resolve));\n  };\n  const first = runCollection({}, 'first', collector);\n  const second = runCollection({}, 'second', collector);\n  await Promise.resolve();\n  assert.equal(calls, 2);\n  resolvers[0]('first');\n  resolvers[1]('second');\n  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);\n});\n\ntest('chat fallback preserves the caller abort signal', async () => {\n  const controller = new AbortController();\n  const signal = combinedAbortSignal(controller.signal, 1_000);\n  assert.equal(signal.aborted, false);\n  controller.abort(new Error('caller timeout'));\n  assert.equal(signal.aborted, true);\n});\n\ntest('chat fallback still has its own timeout without a caller signal', async () => {\n  const signal = combinedAbortSignal(null, 5);\n  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));\n  assert.equal(signal.aborted, true);\n});\n`);
