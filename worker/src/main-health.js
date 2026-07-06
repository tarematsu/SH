export function normalizeHealthPayload(payload) {
  if (payload?.cloud_solo_phase === 'idle') {
    if (payload.cloud_solo_session_id === 0) payload.cloud_solo_session_id = null;
    if (payload.cloud_solo_station_id === 0) payload.cloud_solo_station_id = null;
  }
  return payload;
}

export async function rewriteHealthResponse(response) {
  const payload = await response.clone().json().catch(() => null);
  if (!payload) return response;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(normalizeHealthPayload(payload)), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
