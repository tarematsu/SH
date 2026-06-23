function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

function badRequest(message) {
  return Response.json({ error: message }, { status: 400 });
}

export async function onRequestPost(context) {
  const auth = context.request.headers.get("Authorization");
  if (!context.env.INGEST_SECRET) {
    return Response.json({ error: "server secret is not configured" }, { status: 500 });
  }
  if (auth !== `Bearer ${context.env.INGEST_SECRET}`) {
    return unauthorized();
  }

  let body;
  try {
    body = await context.request.json();
  } catch {
    return badRequest("invalid json");
  }

  if (!body.observedAt || !body.channelSlug) {
    return badRequest("observedAt and channelSlug are required");
  }

  const comments = Array.isArray(body.comments)
    ? body.comments.slice(0, 40)
    : [];

  const statements = [
    context.env.DB.prepare(`
      INSERT OR IGNORE INTO snapshots
      (observed_at, channel_slug, status, play_count, comment_count, source, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      body.observedAt,
      body.channelSlug,
      body.status ?? null,
      Number.isFinite(body.playCount) ? body.playCount : null,
      Number.isFinite(body.commentCount) ? body.commentCount : null,
      body.source ?? "scraper",
      JSON.stringify(body.raw ?? null)
    )
  ];

  for (const comment of comments) {
    if (!comment.key || !comment.text || !comment.observedAt) continue;
    statements.push(
      context.env.DB.prepare(`
        INSERT OR IGNORE INTO comments
        (channel_slug, comment_key, observed_at, author_name, comment_text, source, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        body.channelSlug,
        comment.key,
        comment.observedAt,
        comment.author ?? null,
        comment.text,
        body.source ?? "scraper",
        JSON.stringify(comment.raw ?? null)
      )
    );
  }

  const results = await context.env.DB.batch(statements);
  return Response.json({ ok: true, operations: results.length });
}