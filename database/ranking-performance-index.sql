CREATE INDEX IF NOT EXISTS idx_channel_rankings_date_rank
ON sh_channel_rankings (ranking_date, rank);

CREATE INDEX IF NOT EXISTS idx_channel_rankings_type_date
ON sh_channel_rankings (ranking_type, ranking_date);

CREATE INDEX IF NOT EXISTS idx_channel_rankings_channel_date
ON sh_channel_rankings (channel_name, ranking_date);
