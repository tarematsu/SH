import app from './scheduled-main.js';
import { getCollectorHealthView } from './health-alert.js';
import { sanitizeFailureDetail } from './collector-failure.js';

const RAW_ERROR_FIELDS = [
  'last_error',
  'auth_last_error',
  'browser_last_auth_error',
  'official_news_last_error',
  'cloud_host_last_error',
];

export function sanitizeHealthPayload(payload = {}) {
  const sanitized = { ...payload };
  for (const field of RAW_ERROR_FIELDS) {
    if (!(field in sanitized)) continue;
    sanitized[`${field}_present`] = Boolean(sanitized[field]);
    delete sanitized[field];
  }
  return sanitized;
}

export function healthResponseStatus(baseStatus, collectorHealth) {
  const status = Number.isInteger(baseStatus) && baseStatus >= 100 && baseStatus <= 599
    ? baseStatus
    : 500;
  if (status >= 200 && status < 300 && collectorHealth?.collector_health_ok === false) {
    return 503;
  }
  return status;
}

export default {
  async fetch(request, env, ctx) {
    const response = await app.fetch(request, env, ctx);
    if (!new URL(request.url).pathname.endsWith('/health')) return response;
    let payload = null;
    try {
      payload = await response.clone().json();
    } catch {
      return response;
    }
    const collectorHealth = await getCollectorHealthView(env).catch((error) => ({
      collector_health_ok: false,
      collector_health_error_present: true,
      collector_health_error: sanitizeFailureDetail(error?.message || error),
    }));
    return Response.json(sanitizeHealthPayload({
      ...payload,
      ...collectorHealth,
    }), {
      status: healthResponseStatus(response.status, collectorHealth),
    });
  },
};
