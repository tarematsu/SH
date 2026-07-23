-- Store the finalized playback position on the fact row so playback enrichment
-- can patch one row instead of updating both the fact and sparse context rows.
-- The deployment migrator skips this one-column migration when the column is
-- already present, making workflow reruns safe.
ALTER TABLE sh_minute_facts ADD COLUMN queue_position_patch INTEGER;
