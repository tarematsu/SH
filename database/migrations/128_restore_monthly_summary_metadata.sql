UPDATE sh_monthly_summary
SET distinct_tracks=(SELECT backup.distinct_tracks FROM sh_monthly_summary_metadata_backup backup WHERE backup.period_key=sh_monthly_summary.period_key),
    primary_host=(SELECT backup.primary_host FROM sh_monthly_summary_metadata_backup backup WHERE backup.period_key=sh_monthly_summary.period_key)
WHERE period_key IN(SELECT period_key FROM sh_monthly_summary_metadata_backup);
DROP TABLE sh_monthly_summary_metadata_backup;
