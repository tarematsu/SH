-- The raw legacy archive has been migrated to MINUTE_DB and is no longer an
-- active source. Drop the compatibility view first so the table can be
-- removed on both existing and freshly provisioned databases.
DROP VIEW IF EXISTS sh_legacy_history_rows;
DROP TABLE IF EXISTS sh_legacy_snapshots;
