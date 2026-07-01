-- Range scans in /api/track-likes filter only by observed_at.
-- The existing station/track/time index cannot serve that access pattern.

CREATE INDEX IF NOT EXISTS idx_sh_track_like_observations_observed_at
ON sh_track_like_observations(observed_at);
