export async function onRequestGet(context) {
  const latest = await context.env.DB.prepare(`
    SELECT observed_at, channel_slug, status, play_count, comment_count, source
    FROM snapshots
    ORDER BY observed_at DESC
    LIMIT 1
  `).first();

  const history = await context.env.DB.prepare(`
    SELECT observed_at, play_count, comment_count
    FROM snapshots
    WHERE observed_at >= datetime('now', '-24 hours')
    ORDER BY observed_at ASC
    LIMIT 2000
  `).all();

  const comments = await context.env.DB.prepare(`
    SELECT observed_at, author_name, comment_text, source
    FROM comments
    ORDER BY observed_at DESC
    LIMIT 100
  `).all();

  return Response.json(
    {
      latest: latest ?? null,
      history: history.results ?? [],
      comments: comments.results ?? []
    },
    {
      headers: {
        "Cache-Control": "public, max-age=15"
      }
    }
  );
}