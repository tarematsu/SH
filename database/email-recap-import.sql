CREATE TABLE IF NOT EXISTS sh_email_stream_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL UNIQUE,
  week_of TEXT NOT NULL,
  email_sent_at INTEGER NOT NULL,
  stream_count INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'stationhead_email_recap',
  validation_status TEXT NOT NULL,
  reference_source TEXT,
  reference_observed_at INTEGER,
  reference_stream_count INTEGER,
  estimated_stream_count INTEGER,
  difference INTEGER,
  relative_difference REAL,
  time_distance_minutes REAL,
  imported_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sh_email_stream_snapshots_time
ON sh_email_stream_snapshots(email_sent_at);

DROP TABLE IF EXISTS temp.email_recap_values;
CREATE TEMP TABLE email_recap_values (
  week_of TEXT NOT NULL,
  email_sent_at INTEGER NOT NULL,
  email_stream_count INTEGER NOT NULL
);

INSERT INTO email_recap_values VALUES
  ('2025-12-01',1765202464000,35740602),
  ('2025-12-08',1765807249000,36235610),
  ('2025-12-15',1766412243000,36694932),
  ('2025-12-22',1767016909000,37087169),
  ('2025-12-29',1767621791000,37573631),
  ('2026-01-05',1768226697000,38024921),
  ('2026-01-12',1768831476000,38449924),
  ('2026-01-19',1769436068000,38904764),
  ('2026-01-26',1770040870000,39339510),
  ('2026-02-02',1770645682000,39750934),
  ('2026-02-09',1771250537000,40312074),
  ('2026-02-16',1771855321000,40788869),
  ('2026-02-23',1772460242000,41306614),
  ('2026-03-02',1773061342000,41774678),
  ('2026-03-09',1773666264000,42251363),
  ('2026-03-16',1774270957000,42689563),
  ('2026-03-23',1774875621000,43125588),
  ('2026-03-30',1775480528000,43540123),
  ('2026-05-04',1778504460000,45552854),
  ('2026-05-11',1779109382000,45903824),
  ('2026-05-18',1779714072000,46377895),
  ('2026-05-25',1780318896000,46802122),
  ('2026-06-01',1780923836000,47190350),
  ('2026-06-08',1781528583000,47576224),
  ('2026-06-15',1782133437000,47986298);

DROP TABLE IF EXISTS temp.email_recap_source_points;
CREATE TEMP TABLE email_recap_source_points AS
SELECT observed_at,total_stream_count AS stream_count,'legacy' AS reference_source
FROM sh_legacy_snapshots
WHERE total_stream_count IS NOT NULL
UNION ALL
SELECT observed_at,current_stream_count AS stream_count,'live' AS reference_source
FROM sh_channel_snapshots
WHERE current_stream_count IS NOT NULL;

DROP TABLE IF EXISTS temp.email_recap_assessed;
CREATE TEMP TABLE email_recap_assessed AS
WITH neighbors AS (
  SELECT
    e.*,
    (SELECT observed_at FROM email_recap_source_points s
      WHERE s.observed_at<=e.email_sent_at ORDER BY s.observed_at DESC LIMIT 1) AS previous_at,
    (SELECT stream_count FROM email_recap_source_points s
      WHERE s.observed_at<=e.email_sent_at ORDER BY s.observed_at DESC LIMIT 1) AS previous_count,
    (SELECT observed_at FROM email_recap_source_points s
      WHERE s.observed_at>=e.email_sent_at ORDER BY s.observed_at ASC LIMIT 1) AS next_at,
    (SELECT stream_count FROM email_recap_source_points s
      WHERE s.observed_at>=e.email_sent_at ORDER BY s.observed_at ASC LIMIT 1) AS next_count,
    (SELECT observed_at FROM email_recap_source_points s
      ORDER BY ABS(s.observed_at-e.email_sent_at),
               CASE s.reference_source WHEN 'live' THEN 0 ELSE 1 END,
               s.observed_at DESC LIMIT 1) AS nearest_at,
    (SELECT stream_count FROM email_recap_source_points s
      ORDER BY ABS(s.observed_at-e.email_sent_at),
               CASE s.reference_source WHEN 'live' THEN 0 ELSE 1 END,
               s.observed_at DESC LIMIT 1) AS nearest_count,
    (SELECT reference_source FROM email_recap_source_points s
      ORDER BY ABS(s.observed_at-e.email_sent_at),
               CASE s.reference_source WHEN 'live' THEN 0 ELSE 1 END,
               s.observed_at DESC LIMIT 1) AS nearest_source
  FROM email_recap_values e
), estimated AS (
  SELECT
    *,
    CASE
      WHEN previous_at IS NOT NULL AND next_at IS NOT NULL AND next_at>previous_at
        THEN CAST(ROUND(previous_count+
          (next_count-previous_count)*1.0*(email_sent_at-previous_at)/(next_at-previous_at)) AS INTEGER)
      ELSE nearest_count
    END AS estimated_count
  FROM neighbors
)
SELECT
  *,
  email_stream_count-estimated_count AS difference,
  CASE WHEN email_stream_count>0 AND estimated_count IS NOT NULL
    THEN ABS(email_stream_count-estimated_count)*1.0/email_stream_count END AS relative_difference,
  CASE WHEN nearest_at IS NOT NULL
    THEN ABS(nearest_at-email_sent_at)/60000.0 END AS time_distance_minutes,
  CASE
    WHEN estimated_count IS NULL THEN 'no_reference'
    WHEN ABS(nearest_at-email_sent_at)/60000.0>1440 THEN 'reference_far'
    WHEN ABS(email_stream_count-estimated_count)<=1000 THEN 'excellent'
    WHEN ABS(email_stream_count-estimated_count)<=10000 THEN 'good'
    WHEN ABS(email_stream_count-estimated_count)<=50000
      AND ABS(email_stream_count-estimated_count)*1.0/email_stream_count<=0.001 THEN 'plausible'
    ELSE 'mismatch'
  END AS validation_status
FROM estimated;

INSERT INTO sh_email_stream_snapshots (
  source_key,week_of,email_sent_at,stream_count,source,validation_status,
  reference_source,reference_observed_at,reference_stream_count,
  estimated_stream_count,difference,relative_difference,time_distance_minutes,imported_at
)
SELECT
  'stationhead-email:' || week_of,
  week_of,
  email_sent_at,
  email_stream_count,
  'stationhead_email_recap',
  validation_status,
  nearest_source,
  nearest_at,
  nearest_count,
  estimated_count,
  difference,
  relative_difference,
  time_distance_minutes,
  CAST(strftime('%s','now') AS INTEGER)*1000
FROM email_recap_assessed
WHERE validation_status IN ('excellent','good','plausible')
ON CONFLICT(source_key) DO UPDATE SET
  email_sent_at=excluded.email_sent_at,
  stream_count=excluded.stream_count,
  validation_status=excluded.validation_status,
  reference_source=excluded.reference_source,
  reference_observed_at=excluded.reference_observed_at,
  reference_stream_count=excluded.reference_stream_count,
  estimated_stream_count=excluded.estimated_stream_count,
  difference=excluded.difference,
  relative_difference=excluded.relative_difference,
  time_distance_minutes=excluded.time_distance_minutes,
  imported_at=excluded.imported_at;

SELECT
  validation_status,
  COUNT(*) AS rows_checked,
  SUM(CASE WHEN validation_status IN ('excellent','good','plausible') THEN 1 ELSE 0 END) AS rows_imported
FROM email_recap_assessed
GROUP BY validation_status
ORDER BY validation_status;
