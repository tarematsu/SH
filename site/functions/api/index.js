import {
  API_CONTRACT_VERSION,
  API_GROUPS,
  RETIRED_ENDPOINTS,
} from '../lib/api-contract.js';

export function apiCatalog(now = Date.now()) {
  return {
    ok: true,
    service: 'stationhead-pages-api',
    gateway: 'cloudflare-pages',
    contract_version: API_CONTRACT_VERSION,
    worker_urls_public: false,
    public_write_api: false,
    generated_at: now,
    generated_at_iso: new Date(now).toISOString(),
    groups: API_GROUPS,
    retired: RETIRED_ENDPOINTS,
  };
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return Response.json({ ok: false, error: 'method-not-allowed' }, {
      status: 405,
      headers: { allow: 'GET' },
    });
  }
  return Response.json(apiCatalog(), {
    headers: {
      'cache-control': 'public, max-age=300, s-maxage=3600',
      'x-content-type-options': 'nosniff',
    },
  });
}
