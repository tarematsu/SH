CREATE TABLE IF NOT EXISTS sh_pages_track_history_read_model (
  row_key TEXT PRIMARY KEY,
  play_date TEXT NOT NULL,
  first_played_at INTEGER,
  row_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sh_pages_track_history_publication_cursor
  ON sh_pages_track_history_read_model(
    play_date,
    COALESCE(first_played_at,-1),
    row_key
  );
