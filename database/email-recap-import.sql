CREATE TABLE IF NOT EXISTS sh_email_stream_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL UNIQUE,
  week_of TEXT NOT NULL,
  email_sent_at INTEGER NOT NULL,
  effective_at INTEGER NOT NULL,
  stream_count INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'stationhead_email_recap',
  validation_status TEXT NOT NULL,
  timing_basis TEXT NOT NULL DEFAULT 'email_sent_minus_57m',
  timing_offset_minutes INTEGER NOT NULL DEFAULT 57,
  reference_source TEXT,
  estimated_stream_count INTEGER,
  difference INTEGER,
  relative_difference REAL,
  nearest_distance_minutes REAL,
  validation_notes TEXT,
  imported_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sh_email_stream_snapshots_effective
ON sh_email_stream_snapshots(effective_at);

CREATE INDEX IF NOT EXISTS idx_sh_email_stream_snapshots_sent
ON sh_email_stream_snapshots(email_sent_at);

INSERT INTO sh_email_stream_snapshots (
  source_key,week_of,email_sent_at,effective_at,stream_count,source,
  validation_status,timing_basis,timing_offset_minutes,reference_source,
  estimated_stream_count,difference,relative_difference,nearest_distance_minutes,
  validation_notes,imported_at
) VALUES
  ('stationhead-email:2025-12-01','2025-12-01',1765202464000,1765199074000,35740602,'stationhead_email_recap','validated_good','email_sent_minus_57m',57,'sh_daily_summary_interpolation',35742429,-1827,0.0000511,57.9,'Email value trails send-time estimate by 1827; pattern matches a report cutoff about 57 minutes before delivery.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2025-12-08','2025-12-08',1765807249000,1765803859000,36235610,'stationhead_email_recap','validated_good','email_sent_minus_57m',57,'sh_daily_summary_interpolation',36237499,-1889,0.0000521,58.2,'Email value trails send-time estimate by 1889; pattern matches a report cutoff about 57 minutes before delivery.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2025-12-15','2025-12-15',1766412243000,1766408853000,36694932,'stationhead_email_recap','validated_good','email_sent_minus_57m',57,'sh_daily_summary_interpolation',36696687,-1755,0.0000478,54.0,'Email value trails send-time estimate by 1755; pattern matches a report cutoff about 57 minutes before delivery.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2025-12-22','2025-12-22',1767016909000,1767013519000,37087169,'stationhead_email_recap','validated_good','email_sent_minus_57m',57,'sh_daily_summary_interpolation',37088983,-1814,0.0000489,57.2,'Email value trails send-time estimate by 1814; pattern matches a report cutoff about 57 minutes before delivery.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2025-12-29','2025-12-29',1767621791000,1767618401000,37573631,'stationhead_email_recap','validated_good','email_sent_minus_57m',57,'sh_daily_summary_interpolation',37575444,-1813,0.0000483,55.8,'Email value trails send-time estimate by 1813; pattern matches a report cutoff about 57 minutes before delivery.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-01-05','2026-01-05',1768226697000,1768223307000,38024921,'stationhead_email_recap','validated_good','email_sent_minus_57m',57,'sh_daily_summary_interpolation',38026462,-1541,0.0000405,54.0,'Email value trails send-time estimate by 1541; pattern matches a report cutoff about 57 minutes before delivery.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-01-12','2026-01-12',1768831476000,1768828086000,38449924,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-01-19','2026-01-19',1769436068000,1769432678000,38904764,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-01-26','2026-01-26',1770040870000,1770037480000,39339510,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-02-02','2026-02-02',1770645682000,1770642292000,39750934,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-02-09','2026-02-09',1771250537000,1771247147000,40312074,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-02-16','2026-02-16',1771855321000,1771851931000,40788869,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-02-23','2026-02-23',1772460242000,1772456852000,41306614,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-03-02','2026-03-02',1773061342000,1773057952000,41774678,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-03-09','2026-03-09',1773666264000,1773662874000,42251363,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-03-16','2026-03-16',1774270957000,1774267567000,42689563,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-03-23','2026-03-23',1774875621000,1774872231000,43125588,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-03-30','2026-03-30',1775480528000,1775477138000,43540123,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-05-04','2026-05-04',1778504460000,1778501070000,45552854,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-05-11','2026-05-11',1779109382000,1779105992000,45903824,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-05-18','2026-05-18',1779714072000,1779710682000,46377895,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-05-25','2026-05-25',1780318896000,1780315506000,46802122,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-06-01','2026-06-01',1780923836000,1780920446000,47190350,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-06-08','2026-06-08',1781528583000,1781525193000,47576224,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000),
  ('stationhead-email:2026-06-15','2026-06-15',1782133437000,1782130047000,47986298,'stationhead_email_recap','unverified_reference_gap','email_sent_minus_57m',57,'official_email_series',NULL,NULL,NULL,NULL,'No nearby original database point; retained because it is an official monotonic weekly recap value.',CAST(strftime('%s','now') AS INTEGER)*1000)
ON CONFLICT(source_key) DO UPDATE SET
  week_of=excluded.week_of,
  email_sent_at=excluded.email_sent_at,
  effective_at=excluded.effective_at,
  stream_count=excluded.stream_count,
  validation_status=excluded.validation_status,
  timing_basis=excluded.timing_basis,
  timing_offset_minutes=excluded.timing_offset_minutes,
  reference_source=excluded.reference_source,
  estimated_stream_count=excluded.estimated_stream_count,
  difference=excluded.difference,
  relative_difference=excluded.relative_difference,
  nearest_distance_minutes=excluded.nearest_distance_minutes,
  validation_notes=excluded.validation_notes,
  imported_at=excluded.imported_at;

SELECT
  validation_status,
  COUNT(*) AS row_count,
  MIN(datetime(effective_at/1000,'unixepoch','+9 hours')) AS first_effective_jst,
  MAX(datetime(effective_at/1000,'unixepoch','+9 hours')) AS last_effective_jst
FROM sh_email_stream_snapshots
GROUP BY validation_status
ORDER BY validation_status;
