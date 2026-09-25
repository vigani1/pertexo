-- ADR 045: webhook deliveries become a metadata-only delivery log. Existing
-- rows are admitted deliveries, so the constant defaults backfill them without
-- a table rewrite and let the previous API version keep writing correct
-- accepted rows during a rolling deployment or rollback. Sizes recorded before
-- this migration are unknown and stay null.
ALTER TABLE app.webhook_trigger_deliveries
  ADD COLUMN outcome varchar(32) NOT NULL DEFAULT 'accepted',
  ADD COLUMN http_status smallint NOT NULL DEFAULT 202,
  ADD COLUMN signature_check varchar(16) NOT NULL DEFAULT 'verified',
  ADD COLUMN replay_check varchar(16) NOT NULL DEFAULT 'new',
  ADD COLUMN body_bytes integer,
  ALTER COLUMN workflow_run_id DROP NOT NULL,
  ALTER COLUMN dedupe_kind DROP NOT NULL;

-- Each outcome fixes the HTTP status that was returned, the signature and
-- replay checks that ran, and whether a run exists. Only accepted and replayed
-- deliveries reference a run. NOT VALID enforces the invariant for concurrent
-- writes before the retained rows are scanned.
ALTER TABLE app.webhook_trigger_deliveries
  ADD CONSTRAINT webhook_trigger_deliveries_body_bytes_valid
    CHECK (body_bytes IS NULL OR body_bytes BETWEEN 0 AND 262144) NOT VALID,
  ADD CONSTRAINT webhook_trigger_deliveries_outcome_valid CHECK (
    (outcome='accepted' AND http_status=202 AND signature_check='verified'
      AND replay_check='new'
      AND workflow_run_id IS NOT NULL AND dedupe_kind IS NOT NULL)
    OR (outcome='replayed' AND http_status=202 AND signature_check='verified'
      AND replay_check='duplicate'
      AND workflow_run_id IS NOT NULL AND dedupe_kind IS NOT NULL)
    OR (workflow_run_id IS NULL AND (
      (outcome='authentication_failed' AND http_status=401 AND (
        (signature_check='not_checked' AND replay_check='stale_timestamp')
        OR (signature_check='mismatch' AND replay_check='not_checked')
        OR (signature_check='verified' AND replay_check='new')))
      OR (outcome='invalid_request' AND http_status=400
        AND signature_check='verified' AND replay_check='not_checked')
      OR (outcome='conflict' AND http_status=409
        AND signature_check='verified' AND replay_check='conflict')
      OR (outcome='rate_limited' AND http_status=429
        AND signature_check='verified' AND replay_check='new')))
  ) NOT VALID;

ALTER TABLE app.webhook_trigger_deliveries
  VALIDATE CONSTRAINT webhook_trigger_deliveries_body_bytes_valid;
ALTER TABLE app.webhook_trigger_deliveries
  VALIDATE CONSTRAINT webhook_trigger_deliveries_outcome_valid;
