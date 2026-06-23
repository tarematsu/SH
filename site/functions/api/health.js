export async function onRequestGet(context) {
  const result = await context.env.DB
    .prepare("SELECT COUNT(*) AS count FROM snapshots")
    .first();

  return Response.json({
    ok: true,
    snapshotCount: result?.count ?? 0,
    time: new Date().toISOString()
  });
}