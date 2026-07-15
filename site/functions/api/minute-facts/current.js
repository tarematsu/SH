import { onRequestGet as minuteFactsResponse } from '../history-migrated.js';

export function currentMinuteFactsRequest(request) {
  const url = new URL(request.url);
  url.searchParams.set('latest', '1');
  return new Request(url.toString(), {
    method: 'GET',
    headers: request.headers,
  });
}

export async function onRequestGet(context) {
  return minuteFactsResponse({
    ...context,
    request: currentMinuteFactsRequest(context.request),
  });
}
