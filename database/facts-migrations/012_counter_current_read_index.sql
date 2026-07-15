-- Support cached Pages rankings without scanning every retained counter occurrence.
CREATE INDEX IF NOT EXISTS idx_sh_counter_current_observed_count
  ON sh_track_counter_current(observed_at DESC,count_value DESC);

PRAGMA optimize;
