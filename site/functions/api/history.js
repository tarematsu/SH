const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600',
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });

const SUMMARY_TABLES = {
  daily: 'sh_daily_summary',
  weekly: 'sh_weekly_summary',
  monthly: 'sh_monthly_summary',
};

const SUMMARY_COLUMNS = `period_key,sample_count,reliable_sample_count,
listener_avg,listener_min,listener_max,stream_start,stream_end,stream_growth,
member_start,member_end,member_growth,likes_max,distinct_tracks,primary_host,
quality_score,quality_flags`;

function parseDateStart(value, fallback) {
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : fallback;
  return Date.parse(`${text}T00:00:00+09:00`);
}

function addDays(ts, days) {
  return ts + days * 86400000;
}

function encodeCursor(row) {
  if (!row) return null;
  return btoa(`${row.observed_at}:${row.id}`);
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const [ts, id] = atob(value).split(':').map(Number);
    return Number.isFinite(ts) && Number.isFinite(id) ? { ts, id } : null;
  } catch {
    return null;
  }
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'DB binding missing' }, 500);

  try {
    const url = new URL(request.url);
    const mode = url.searchParams.get('mode') || 'weekly';
    const from = url.searchParams.get('from') || '2024-06-01';
    const to = url.searchParams.get('to') || new Date().toISOString().slice(0, 10);

    if (mode === 'raw') {
      const fromTs = parseDateStart(from, '2024-06-01');
      const requestedToTs = addDays(parseDateStart(to, new Date().toISOString().slice(0, 10)), 1);
      // 誤操作で長期間の54万行を走査しないよう、詳細表示は最大31日。
      const toTs = Math.min(requestedToTs, addDays(fromTs, 31));
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 20), 500);
      const cursor = decodeCursor(url.searchParams.get('cursor'));

      let sql = `SELECT id,observed_at,observed_jst,listener_count,total_stream_count,
track_title,artist_name,likes,comment_velocity,host_handle,total_member_count,
source_note,quality_score,quality_flags
FROM sh_legacy_snapshots
WHERE observed_at>=? AND observed_at<?`;
      const binds = [fromTs, toTs];

      if (cursor) {
        sql += ' AND (observed_at>? OR (observed_at=? AND id>?))';
        binds.push(cursor.ts, cursor.ts, cursor.id);
      }

      sql += ' ORDER BY observed_at ASC,id ASC LIMIT ?';
      binds.push(limit + 1);

      const result = await env.DB.prepare(sql).bind(...binds).all();
      const allRows = result.results || [];
      const hasMore = allRows.length > limit;
      const rows = hasMore ? allRows.slice(0, limit) : allRows;
      const nextCursor = hasMore ? encodeCursor(rows.at(-1)) : null;

      return json(
        { ok: true, mode, from, to, rows, has_more: hasMore, next_cursor: nextCursor },
        200,
        { 'cache-control': 'private, max-age=60' },
      );
    }

    const table = SUMMARY_TABLES[mode] || SUMMARY_TABLES.weekly;
    const limit = mode === 'daily' ? 800 : mode === 'weekly' ? 160 : 60;
    const result = await env.DB.prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM ${table}
       WHERE period_key>=? AND period_key<=?
       ORDER BY period_key ASC LIMIT ?`,
    ).bind(from, to, limit).all();

    // 集計テーブルは最大でも数百行。追加のCOUNT/MAX SQLを発行せずJSで要約する。
    const rows = result.results || [];
    const importRun = url.searchParams.get('include_import') === '1'
      ? await env.DB.prepare(
          `SELECT imported_at,source_rows,accepted_rows,skipped_rows,duplicate_rows,warning_rows
           FROM sh_history_import_runs ORDER BY imported_at DESC LIMIT 1`,
        ).first()
      : null;

    return json({ ok: true, mode, from, to, rows, import: importRun });
  } catch (error) {
    return json({ ok: false, error: error?.message || 'history error' }, 500, {
      'cache-control': 'no-store',
    });
  }
}
