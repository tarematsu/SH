INSERT INTO sh_comment_state(station_id,last_comment_id,total_count,last_observed_at)
SELECT station_id,MAX(id),COUNT(*),MAX(observed_at)
FROM sh_comments
WHERE station_id IS NOT NULL
GROUP BY station_id;
