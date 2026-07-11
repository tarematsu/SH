import { combinedAbortSignal } from './request-signal.js';

const DEFAULT_TIMEOUT_MS = 12_000;

function signalFrom(value) {
  return value?.__COLLECTION_ABORT_SIGNAL || (value?.aborted === true ? value : null);
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('minute fact write aborted'), { name: 'AbortError' });
}

function boundedEnv(env, signal) {
  const wrap = (db) => !db ? db : new Proxy(db, { get(target, property) {
    if (property !== 'prepare') return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
    return (sql) => { if (signal.aborted) throw abortError(signal); const statement = target.prepare(sql); return new Proxy(statement, { get(inner, method) {
      if (method === 'bind') return (...args) => inner.bind(...args);
      const value = inner[method];
      if (typeof value !== 'function') return value;
      return async (...args) => { if (signal.aborted) throw abortError(signal); const result = await value.apply(inner, args); if (signal.aborted) throw abortError(signal); return result; };
    }}); };
  }});
  return new Proxy(env || {}, { get(target, property) { if (property === 'DB' || property === 'FACTS_DB') return wrap(target[property]); return target[property]; } });
}

export async function saveMinuteFactWithinBudget(env, input, writer) {
  const configured = Number(env?.MINUTE_FACT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const timeout = Number.isFinite(configured) ? Math.max(1_000, Math.min(20_000, configured)) : DEFAULT_TIMEOUT_MS;
  const signal = combinedAbortSignal(signalFrom(env), timeout);
  const abort = new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError(signal)), { once: true }));
  return Promise.race([Promise.resolve().then(() => writer(boundedEnv(env, signal), input)), abort]);
}
