export function compatibilityRedirect(request, successor, status = 308) {
  const source = new URL(request.url);
  const target = new URL(successor, source.origin);
  for (const [key, value] of source.searchParams) {
    if (!target.searchParams.has(key)) target.searchParams.append(key, value);
  }
  return new Response(null, {
    status,
    headers: {
      location: `${target.pathname}${target.search}`,
      deprecation: 'true',
      link: `<${successor}>; rel="successor-version"`,
      'x-api-successor': successor,
      'cache-control': 'public, max-age=300, s-maxage=3600',
      'x-content-type-options': 'nosniff',
    },
  });
}
