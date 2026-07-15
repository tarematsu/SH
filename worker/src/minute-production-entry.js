import minuteApp from './minute-entry.js';
import { LATEST_MINUTE_FACTS_PATH } from './minute-facts-api.js';

export async function runMinuteFetch(request, env, ctx, dependencies = {}) {
  const pathname = new URL(request.url).pathname;
  if (pathname === LATEST_MINUTE_FACTS_PATH) {
    const handler = dependencies.latestMinuteFactsResponse
      || (await import('./minute-facts-api.js')).latestMinuteFactsResponse;
    return handler(request, env);
  }
  return minuteApp.fetch(request, env, ctx);
}

export default {
  queue: minuteApp.queue,
  scheduled: minuteApp.scheduled,
  fetch: runMinuteFetch,
};
