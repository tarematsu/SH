import { INTERNAL_API_PATHS } from '../lib/api-contract.js';

const blockedApiPaths = new Set(INTERNAL_API_PATHS);

function normalizedPathname(value) {
  const pathname = String(value || '/');
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

export function isBlockedApiPath(pathname) {
  return blockedApiPaths.has(normalizedPathname(pathname));
}

function notFoundResponse() {
  return Response.json({ ok: false, error: 'not found' }, {
    status: 404,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function onRequest(context) {
  const pathname = new URL(context.request.url).pathname;
  if (isBlockedApiPath(pathname)) return notFoundResponse();
  return context.next();
}
