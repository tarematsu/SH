const retired = () => Response.json(
  {
    ok: false,
    error: 'playback endpoint retired; use /api/dashboard',
    replacement: '/api/dashboard',
  },
  {
    status: 404,
    headers: { 'cache-control': 'no-store' },
  },
);

export const onRequestGet = retired;
export const onRequestOptions = retired;
