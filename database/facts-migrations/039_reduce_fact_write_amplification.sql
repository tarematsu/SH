-- Reduce steady-state write amplification on the one-row-per-minute fact table.
-- idx_sh_minute_facts_live_minute has the same key columns as the older
-- source-minute index and is the explicitly selected production index.
DROP INDEX IF EXISTS idx_sh_minute_facts_source_minute_desc;

-- Total-listens values are already ordered by the channel/minute index used by
-- the baseline queries. The cumulative value changes infrequently, so a second
-- covering index adds a write on every minute fact without improving the seek.
DROP INDEX IF EXISTS idx_sh_minute_facts_total_listens_baseline;
