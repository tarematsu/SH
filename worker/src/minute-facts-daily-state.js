import { integer, scoreCode } from './minute-facts-normalize.js';

function compactScoreCode(fact) {
  return integer(fact.quality_score_code) ?? scoreCode(fact.quality_score, 100);
}

export function totalMemberDailyChangeStatement(db, fact) {
  const count = integer(fact.total_member_count);
  if (count == null || count < 0) return db.prepare('SELECT 1 WHERE 0');
  const observedAt = integer(fact.observed_at);
  const dayAt = Math.floor(observedAt / 86_400_000) * 86_400_000;
  const rawHostId = integer(fact.host_id);
  const hostId = rawHostId != null && rawHostId > 0 ? rawHostId : null;
  const hostKey = hostId ?? 0;
  return db.prepare(`INSERT INTO sh_total_member_daily(
      channel_id,day_at,host_key,host_id,first_observed_at,last_observed_at,
      first_total_member_count,last_total_member_count,min_total_member_count,
      max_total_member_count,source_code,source_priority,quality_score_code
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(channel_id,day_at,host_key) DO UPDATE SET
      first_observed_at=MIN(sh_total_member_daily.first_observed_at,excluded.first_observed_at),
      first_total_member_count=CASE WHEN excluded.first_observed_at<sh_total_member_daily.first_observed_at
        THEN excluded.first_total_member_count ELSE sh_total_member_daily.first_total_member_count END,
      last_observed_at=MAX(sh_total_member_daily.last_observed_at,excluded.last_observed_at),
      last_total_member_count=CASE WHEN excluded.last_observed_at>=sh_total_member_daily.last_observed_at
        THEN excluded.last_total_member_count ELSE sh_total_member_daily.last_total_member_count END,
      min_total_member_count=MIN(sh_total_member_daily.min_total_member_count,excluded.min_total_member_count),
      max_total_member_count=MAX(sh_total_member_daily.max_total_member_count,excluded.max_total_member_count),
      source_code=CASE WHEN excluded.last_observed_at>=sh_total_member_daily.last_observed_at
        THEN excluded.source_code ELSE sh_total_member_daily.source_code END,
      source_priority=CASE WHEN excluded.last_observed_at>=sh_total_member_daily.last_observed_at
        THEN excluded.source_priority ELSE sh_total_member_daily.source_priority END,
      quality_score_code=CASE WHEN excluded.last_observed_at>=sh_total_member_daily.last_observed_at
        THEN excluded.quality_score_code ELSE sh_total_member_daily.quality_score_code END
    WHERE excluded.first_observed_at<sh_total_member_daily.first_observed_at
      OR excluded.min_total_member_count<sh_total_member_daily.min_total_member_count
      OR excluded.max_total_member_count>sh_total_member_daily.max_total_member_count
      OR (excluded.last_observed_at>=sh_total_member_daily.last_observed_at AND (
        excluded.last_total_member_count IS NOT sh_total_member_daily.last_total_member_count
        OR excluded.source_priority>sh_total_member_daily.source_priority
        OR (excluded.source_priority=sh_total_member_daily.source_priority
          AND excluded.quality_score_code>sh_total_member_daily.quality_score_code)
      ))`).bind(
    fact.channel_id, dayAt, hostKey, hostId, observedAt, observedAt,
    count, count, count, count, fact.source_code, fact.source_priority,
    compactScoreCode(fact),
  );
}
