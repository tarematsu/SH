-- Prediction state is derived from FACTS_DB and is now owned by that DB.
-- It is regenerated from minute facts, so no cross-database copy is needed.
DROP TABLE IF EXISTS sh_stream_goal_prediction_state;

-- Ingest claims are owned by stationhead-buddies. Host rows are written to
-- OTHER_DB only after the claim is accepted in the shared primary DB.
DROP TABLE IF EXISTS sh_ingest_conflicts;
DROP TABLE IF EXISTS sh_ingest_claims;
