CREATE TABLE IF NOT EXISTS sh_official_news_monitor_state (
  id TEXT PRIMARY KEY,
  last_check_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sh_official_news_announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id TEXT NOT NULL,
  news_url TEXT NOT NULL,
  published_date TEXT,
  title TEXT NOT NULL,
  event_name TEXT NOT NULL,
  scheduled_at INTEGER,
  detected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  matched_station_id INTEGER,
  first_broadcast_at INTEGER,
  last_broadcast_at INTEGER,
  inactive_streak INTEGER NOT NULL DEFAULT 0,
  raw_text TEXT,
  UNIQUE(news_id, scheduled_at)
);

CREATE INDEX IF NOT EXISTS idx_sh_official_news_schedule
ON sh_official_news_announcements(status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_sh_official_news_station
ON sh_official_news_announcements(matched_station_id, first_broadcast_at);

CREATE TABLE IF NOT EXISTS sh_official_news_station_probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  observed_minute INTEGER NOT NULL,
  station_id INTEGER,
  broadcast_id INTEGER,
  broadcast_start_time INTEGER,
  is_broadcasting INTEGER,
  listener_count INTEGER,
  guest_count INTEGER,
  total_listens INTEGER,
  status TEXT,
  chat_status TEXT,
  channel_id INTEGER,
  channel_alias TEXT,
  queue_json TEXT,
  raw_json TEXT,
  UNIQUE(announcement_id, observed_minute)
);

CREATE INDEX IF NOT EXISTS idx_sh_official_news_probes_announcement_time
ON sh_official_news_station_probes(announcement_id, observed_at);

CREATE TABLE IF NOT EXISTS sh_official_news_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id INTEGER NOT NULL,
  station_id INTEGER NOT NULL,
  comment_id INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  account_id INTEGER,
  handle TEXT,
  text TEXT,
  chat_time INTEGER,
  chat_time_ms INTEGER,
  raw_json TEXT,
  UNIQUE(announcement_id, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_sh_official_news_comments_time
ON sh_official_news_comments(announcement_id, chat_time_ms, observed_at);
