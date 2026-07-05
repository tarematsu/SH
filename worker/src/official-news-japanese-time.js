export const PROMOTABLE_TIME_UNKNOWN_SQL = `SELECT
    announcement.id,announcement.news_id,announcement.news_url,
    announcement.published_date,announcement.title,announcement.event_name,
    announcement.detected_at,announcement.raw_text
  FROM sh_official_news_announcements AS announcement
  WHERE announcement.status='time_unknown'
    AND EXISTS (
      SELECT 1
      FROM sh_official_news_monitor_state AS monitor
      WHERE monitor.id='official-news'
        AND monitor.last_success_at IS NOT NULL
        AND monitor.last_success_at=monitor.last_check_at
        AND monitor.last_check_at>=?
    )
  ORDER BY announcement.updated_at DESC,announcement.id DESC
  LIMIT 20`;

function jstTimestamp(year, month, day, hour, minute) {
  const extraDays = Math.floor(hour / 24);
  const normalizedHour = hour % 24;
  return Date.UTC(year, month - 1, day + extraDays, normalizedHour - 9, minute);
}

export function japaneseHourScheduleTimes(text, fallbackYear) {
  const source = String(text || '');
  const values = new Set();
  const full = /(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s*[（(][^）)]*[）)])?\s*(\d{1,2})時(?:\s*(\d{1,2})分)?(?:\s*頃)?/g;
  let match;
  while ((match = full.exec(source))) {
    const [year, month, day, hour] = match.slice(1, 5).map(Number);
    const minute = Number(match[5] || 0);
    values.add(jstTimestamp(year, month, day, hour, minute));
  }

  const partial = /(?<![年\d])(\d{1,2})月\s*(\d{1,2})日(?:\s*[（(][^）)]*[）)])?\s*(\d{1,2})時(?:\s*(\d{1,2})分)?(?:\s*頃)?/g;
  while ((match = partial.exec(source))) {
    const [month, day, hour] = match.slice(1, 4).map(Number);
    const minute = Number(match[4] || 0);
    values.add(jstTimestamp(Number(fallbackYear), month, day, hour, minute));
  }

  return [...values].filter(Number.isFinite).sort((a, b) => a - b);
}

function promotionInsert(env, row, scheduledAt, completedAt) {
  return env.DB.prepare(`INSERT INTO sh_official_news_announcements
      (news_id,news_url,published_date,title,event_name,scheduled_at,detected_at,updated_at,status,raw_text)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(news_id,scheduled_at) DO UPDATE SET
      news_url=excluded.news_url,published_date=excluded.published_date,
      title=excluded.title,event_name=excluded.event_name,
      updated_at=excluded.updated_at,raw_text=excluded.raw_text,
      status=CASE
        WHEN sh_official_news_announcements.status IN ('active','ended')
          THEN sh_official_news_announcements.status
        ELSE 'scheduled'
      END
    WHERE sh_official_news_announcements.news_url IS NOT excluded.news_url
       OR sh_official_news_announcements.published_date IS NOT excluded.published_date
       OR sh_official_news_announcements.title IS NOT excluded.title
       OR sh_official_news_announcements.event_name IS NOT excluded.event_name
       OR sh_official_news_announcements.raw_text IS NOT excluded.raw_text
       OR sh_official_news_announcements.status NOT IN ('scheduled','active','ended')`)
    .bind(
      row.news_id,row.news_url,row.published_date,row.title,row.event_name,
      scheduledAt,row.detected_at || completedAt,completedAt,'scheduled',row.raw_text,
    );
}

export async function promoteJapaneseHourAnnouncements(
  env,
  runStartedAt = Date.now(),
  completedAt = Date.now(),
) {
  if (!env?.DB) return { promoted: 0, skipped: true };
  const result = await env.DB.prepare(PROMOTABLE_TIME_UNKNOWN_SQL)
    .bind(runStartedAt)
    .all();
  let promoted = 0;

  for (const row of result.results || []) {
    const fallbackYear = Number(String(row.published_date || '').slice(0, 4))
      || new Date(completedAt + 9 * 3600_000).getUTCFullYear();
    const times = japaneseHourScheduleTimes(row.raw_text, fallbackYear);
    if (!times.length) continue;

    const statements = times.map((scheduledAt) => promotionInsert(
      env,
      row,
      scheduledAt,
      completedAt,
    ));
    const results = await env.DB.batch(statements);
    promoted += (results || []).reduce(
      (total, item) => total + Number(item?.meta?.changes || 0),
      0,
    );
  }

  return { promoted, skipped: false };
}
