// Metadata enrichment now happens before the MINUTE_DB queue read model is
// published. Pages is read-only and does not refresh buddies storage.
export function onRequest() {
  return new Response(null, {
    status: 404,
    headers: { 'cache-control': 'no-store' },
  });
}
