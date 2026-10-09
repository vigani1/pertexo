-- Run health evidence always applies (ADR 069; ADR 059 amendment): an
-- observation no longer records the rollout mode it was produced under.
ALTER TABLE app.connection_health_observations DROP COLUMN production_mode;
