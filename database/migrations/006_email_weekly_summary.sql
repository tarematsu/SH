DROP TRIGGER IF EXISTS trg_sh_email_stream_weekly_insert;
DROP TRIGGER IF EXISTS trg_sh_email_stream_weekly_update;

CREATE TRIGGER trg_sh_email_stream_weekly_insert
AFTER INSERT ON sh_email_stream_snapshots
BEGIN
  INSERT INTO sh_weekly_summary (
    period_key,period_start,period_end,sample_count,reliable_sample_count,
    listener_avg,listener_min,listener_max,
    stream_start,stream_end,stream_growth,
    member_start,member_end,member_growth,likes_max,distinct_tracks,primary_host,
    quality_score,quality_flags,updated_at
  ) VALUES (
    NEW.week_of,
    CAST(strftime('%s', NEW.week_of || ' 00:00:00', '-9 hours') AS INTEGER) * 1000,
    NEW.effective_at,
    1,1,NULL,NULL,NULL,
    (SELECT stream_count FROM sh_email_stream_snapshots
      WHERE week_of=date(NEW.week_of,'-7 days') LIMIT 1),
    NEW.stream_count,
    CASE WHEN (SELECT stream_count FROM sh_email_stream_snapshots
        WHERE week_of=date(NEW.week_of,'-7 days') LIMIT 1) IS NOT NULL
      THEN NEW.stream_count-(SELECT stream_count FROM sh_email_stream_snapshots
        WHERE week_of=date(NEW.week_of,'-7 days') LIMIT 1)
      ELSE NULL END,
    NULL,NULL,NULL,NULL,NULL,NULL,
    0.95,'["stationhead_email_recap"]',
    CAST(strftime('%s','now') AS INTEGER)*1000
  )
  ON CONFLICT(period_key) DO UPDATE SET
    period_end=MAX(sh_weekly_summary.period_end,excluded.period_end),
    stream_start=COALESCE(excluded.stream_start,sh_weekly_summary.stream_start),
    stream_end=excluded.stream_end,
    stream_growth=CASE
      WHEN COALESCE(excluded.stream_start,sh_weekly_summary.stream_start) IS NOT NULL
       AND excluded.stream_end>=COALESCE(excluded.stream_start,sh_weekly_summary.stream_start)
      THEN excluded.stream_end-COALESCE(excluded.stream_start,sh_weekly_summary.stream_start)
      ELSE sh_weekly_summary.stream_growth END,
    quality_score=MAX(sh_weekly_summary.quality_score,excluded.quality_score),
    quality_flags=CASE
      WHEN instr(sh_weekly_summary.quality_flags,'stationhead_email_recap')>0
        THEN sh_weekly_summary.quality_flags
      WHEN json_valid(sh_weekly_summary.quality_flags)
        THEN json_insert(sh_weekly_summary.quality_flags,'$[#]','stationhead_email_recap')
      ELSE excluded.quality_flags END,
    updated_at=excluded.updated_at;
END;

CREATE TRIGGER trg_sh_email_stream_weekly_update
AFTER UPDATE OF week_of,effective_at,stream_count,validation_status ON sh_email_stream_snapshots
BEGIN
  INSERT INTO sh_weekly_summary (
    period_key,period_start,period_end,sample_count,reliable_sample_count,
    listener_avg,listener_min,listener_max,
    stream_start,stream_end,stream_growth,
    member_start,member_end,member_growth,likes_max,distinct_tracks,primary_host,
    quality_score,quality_flags,updated_at
  ) VALUES (
    NEW.week_of,
    CAST(strftime('%s', NEW.week_of || ' 00:00:00', '-9 hours') AS INTEGER) * 1000,
    NEW.effective_at,
    1,1,NULL,NULL,NULL,
    (SELECT stream_count FROM sh_email_stream_snapshots
      WHERE week_of=date(NEW.week_of,'-7 days') LIMIT 1),
    NEW.stream_count,
    CASE WHEN (SELECT stream_count FROM sh_email_stream_snapshots
        WHERE week_of=date(NEW.week_of,'-7 days') LIMIT 1) IS NOT NULL
      THEN NEW.stream_count-(SELECT stream_count FROM sh_email_stream_snapshots
        WHERE week_of=date(NEW.week_of,'-7 days') LIMIT 1)
      ELSE NULL END,
    NULL,NULL,NULL,NULL,NULL,NULL,
    0.95,'["stationhead_email_recap"]',
    CAST(strftime('%s','now') AS INTEGER)*1000
  )
  ON CONFLICT(period_key) DO UPDATE SET
    period_end=MAX(sh_weekly_summary.period_end,excluded.period_end),
    stream_start=COALESCE(excluded.stream_start,sh_weekly_summary.stream_start),
    stream_end=excluded.stream_end,
    stream_growth=CASE
      WHEN COALESCE(excluded.stream_start,sh_weekly_summary.stream_start) IS NOT NULL
       AND excluded.stream_end>=COALESCE(excluded.stream_start,sh_weekly_summary.stream_start)
      THEN excluded.stream_end-COALESCE(excluded.stream_start,sh_weekly_summary.stream_start)
      ELSE sh_weekly_summary.stream_growth END,
    quality_score=MAX(sh_weekly_summary.quality_score,excluded.quality_score),
    quality_flags=CASE
      WHEN instr(sh_weekly_summary.quality_flags,'stationhead_email_recap')>0
        THEN sh_weekly_summary.quality_flags
      WHEN json_valid(sh_weekly_summary.quality_flags)
        THEN json_insert(sh_weekly_summary.quality_flags,'$[#]','stationhead_email_recap')
      ELSE excluded.quality_flags END,
    updated_at=excluded.updated_at;
END;

-- Backfill existing recap rows through the update trigger.
UPDATE sh_email_stream_snapshots
SET validation_status=validation_status;
