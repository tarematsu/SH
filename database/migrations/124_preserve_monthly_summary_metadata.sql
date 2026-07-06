CREATE TABLE IF NOT EXISTS sh_monthly_summary_metadata_backup(period_key TEXT PRIMARY KEY,distinct_tracks INTEGER,primary_host TEXT);
INSERT OR REPLACE INTO sh_monthly_summary_metadata_backup(period_key,distinct_tracks,primary_host) SELECT period_key,distinct_tracks,primary_host FROM sh_monthly_summary;
