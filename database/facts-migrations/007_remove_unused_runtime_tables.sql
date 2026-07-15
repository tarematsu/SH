-- These tables are migration scratch space or an abandoned settings API.
-- The preceding migrations leave the canonical tables in place, so removing
-- these leftovers is safe and keeps MINUTE_DB focused on runtime facts.
DROP TABLE IF EXISTS sh_system_settings;
DROP TABLE IF EXISTS sh_minute_facts_v2;
DROP TABLE IF EXISTS sh_minute_facts_compact;
DROP TABLE IF EXISTS sh_minute_fact_context_compact;
