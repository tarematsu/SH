const HEALTH_ENDPOINTS = Object.freeze([
  { path: '/api/health/collector', service: 'sh-monitor-buddies' },
  { path: '/api/health/minute', service: 'sh-monitor-minute' },
  { path: '/api/health/other', service: 'sh-monitor-other' },
  { path: '/api/minute-facts/latest', service: 'sh-minute-facts' },
]);

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return Response.json({ ok: false, error: 'method-not-allowed' }, {
      status: 405,
      headers: { allow: 'GET' },
    });
  }
  return Response.json({
    ok: true,
    gateway: 'cloudflare-pages',
    endpoints: HEALTH_ENDPOINTS,
  }, {
    headers: { 'cache-control': 'public, max-age=300, s-maxage=3600' },
  });
}
