WITH email_values(week_of, email_sent_at, email_stream_count) AS (
  VALUES
    ('2025-12-01', 1765202464000, 35740602),
    ('2025-12-08', 1765807249000, 36235610),
    ('2025-12-15', 1766412243000, 36694932),
    ('2025-12-22', 1767016909000, 37087169),
    ('2025-12-29', 1767621791000, 37573631),
    ('2026-01-05', 1768226697000, 38024921),
    ('2026-01-12', 1768831476000, 38449924),
    ('2026-01-19', 1769436068000, 38904764),
    ('2026-01-26', 1770040870000, 39339510),
    ('2026-02-02', 1770645682000, 39750934),
    ('2026-02-09', 1771250537000, 40312074),
    ('2026-02-16', 1771855321000, 40788869),
    ('2026-02-23', 1772460242000, 41306614),
    ('2026-03-02', 1773061342000, 41774678),
    ('2026-03-09', 1773666264000, 42251363),
    ('2026-03-16', 1774270957000, 42689563),
    ('2026-03-23', 1774875621000, 43125588),
    ('2026-03-30', 1775480528000, 43540123),
    ('2026-05-04', 1778504460000, 45552854),
    ('2026-05-11', 1779109382000, 45903824),
    ('2026-05-18', 1779714072000, 46377895),
    ('2026-05-25', 1780318896000, 46802122),
    ('2026-06-01', 1780923836000, 47190350),
    ('2026-06-08', 1781528583000, 47576224),
    ('2026-06-15', 1782133437000, 47986298)
),
source_points AS (
  SELECT observed_at, total_stream_count AS stream_count, 'legacy' AS reference_source
  FROM sh_legacy_snapshots
  WHERE total_stream_count IS NOT NULL
  UNION ALL
  SELECT observed_at, current_stream_count AS stream_count, 'live' AS reference_source
  FROM sh_channel_snapshots
  WHERE current_stream_count IS NOT NULL
),
nearest_ranked AS (
  SELECT
    e.week_of,
    s.observed_at AS nearest_at,
    s.stream_count AS nearest_count,
    s.reference_source AS nearest_source,
    ROW_NUMBER() OVER (
      PARTITION BY e.week_of
      ORDER BY ABS(s.observed_at-e.email_sent_at),
               CASE s.reference_source WHEN 'live' THEN 0 ELSE 1 END,
               s.observed_at DESC
    ) AS nearest_rank
  FROM email_values e
  LEFT JOIN source_points s
    ON s.observed_at BETWEEN e.email_sent_at-604800000 AND e.email_sent_at+604800000
),
nearest_values AS (
  SELECT week_of,nearest_at,nearest_count,nearest_source
  FROM nearest_ranked
  WHERE nearest_rank=1
),
neighbor_values AS (
  SELECT
    e.*,
    (SELECT observed_at FROM source_points s
      WHERE s.observed_at<=e.email_sent_at
      ORDER BY s.observed_at DESC LIMIT 1) AS previous_at,
    (SELECT stream_count FROM source_points s
      WHERE s.observed_at<=e.email_sent_at
      ORDER BY s.observed_at DESC LIMIT 1) AS previous_count,
    (SELECT observed_at FROM source_points s
      WHERE s.observed_at>=e.email_sent_at
      ORDER BY s.observed_at ASC LIMIT 1) AS next_at,
    (SELECT stream_count FROM source_points s
      WHERE s.observed_at>=e.email_sent_at
      ORDER BY s.observed_at ASC LIMIT 1) AS next_count,
    n.nearest_at,
    n.nearest_count,
    n.nearest_source
  FROM email_values e
  LEFT JOIN nearest_values n USING (week_of)
),
estimated_values AS (
  SELECT
    *,
    CASE
      WHEN previous_at IS NOT NULL AND next_at IS NOT NULL AND next_at>previous_at
        THEN CAST(ROUND(
          previous_count+
          (next_count-previous_count)*1.0*(email_sent_at-previous_at)/(next_at-previous_at)
        ) AS INTEGER)
      ELSE nearest_count
    END AS estimated_count
  FROM neighbor_values
),
assessed AS (
  SELECT
    *,
    email_stream_count-estimated_count AS difference,
    CASE WHEN email_stream_count>0 AND estimated_count IS NOT NULL
      THEN ABS(email_stream_count-estimated_count)*1.0/email_stream_count
      ELSE NULL END AS relative_difference,
    CASE WHEN nearest_at IS NOT NULL
      THEN ABS(nearest_at-email_sent_at)/60000.0
      ELSE NULL END AS time_distance_minutes
  FROM estimated_values
)
SELECT
  week_of,
  datetime(email_sent_at/1000,'unixepoch','+9 hours') AS email_sent_jst,
  email_stream_count,
  previous_count,
  datetime(previous_at/1000,'unixepoch','+9 hours') AS previous_jst,
  next_count,
  datetime(next_at/1000,'unixepoch','+9 hours') AS next_jst,
  estimated_count,
  difference,
  ROUND(relative_difference*100,5) AS difference_percent,
  ROUND(time_distance_minutes,1) AS nearest_distance_minutes,
  nearest_source,
  CASE
    WHEN estimated_count IS NULL THEN 'no_reference'
    WHEN time_distance_minutes>1440 THEN 'reference_far'
    WHEN ABS(difference)<=1000 THEN 'excellent'
    WHEN ABS(difference)<=10000 THEN 'good'
    WHEN ABS(difference)<=50000 AND relative_difference<=0.001 THEN 'plausible'
    ELSE 'mismatch'
  END AS validation_status
FROM assessed
ORDER BY email_sent_at;
