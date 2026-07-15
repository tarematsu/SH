-- Track metadata consolidation is an explicit, verification-first operation.
-- Do not drop the legacy cache from a routine schema apply before the copy
-- has been confirmed against the live BUDDIES_DB.
SELECT 1;
