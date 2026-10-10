-- Stored digests drop their format versions (ADR 069): workflow checksums,
-- trigger fingerprints, email delivery bindings and provider dispatch
-- bindings are `<kind>:sha256:<hex>`. Hash domains and sealing contexts lose
-- their versions too, so rows written before this cannot be verified or
-- decrypted; a database holding them is recreated.
ALTER TABLE app.workflow_versions
  DROP CONSTRAINT workflow_versions_checksum_format,
  ALTER COLUMN checksum TYPE varchar(74),
  ADD CONSTRAINT workflow_versions_checksum_format
    CHECK ((checksum)::text ~ '^wf:sha256:[0-9a-f]{64}$');

ALTER TABLE app.workflow_input_cases ALTER COLUMN version_checksum TYPE varchar(74);

ALTER TABLE app.workflow_triggers
  DROP CONSTRAINT workflow_triggers_fingerprint_valid,
  ALTER COLUMN config_fingerprint TYPE varchar(79),
  ADD CONSTRAINT workflow_triggers_fingerprint_valid
    CHECK ((config_fingerprint)::text ~ '^trigger:sha256:[0-9a-f]{64}$');

ALTER TABLE app.trigger_schedules
  DROP CONSTRAINT trigger_schedules_fingerprint_valid,
  ALTER COLUMN config_fingerprint TYPE varchar(79),
  ADD CONSTRAINT trigger_schedules_fingerprint_valid
    CHECK ((config_fingerprint)::text ~ '^trigger:sha256:[0-9a-f]{64}$');

ALTER TABLE app.run_failure_notification_intents
  DROP CONSTRAINT run_failure_notification_intents_delivery_binding_format,
  ADD CONSTRAINT run_failure_notification_intents_delivery_binding_format
    CHECK ((delivery_binding IS NULL)
      OR ((delivery_binding)::text ~ '^email:sha256:[0-9a-f]{64}$'));

ALTER TABLE app.node_runs
  DROP CONSTRAINT node_runs_provider_dispatch_binding_format,
  ADD CONSTRAINT node_runs_provider_dispatch_binding_format
    CHECK ((provider_dispatch_binding IS NULL)
      OR ((provider_dispatch_binding)::text ~ '^[a-z][a-z0-9._-]{0,31}:sha256:[0-9a-f]{64}$'));

ALTER TABLE app.preview_attempts
  DROP CONSTRAINT preview_attempts_provider_dispatch_binding_format,
  ADD CONSTRAINT preview_attempts_provider_dispatch_binding_format
    CHECK ((provider_dispatch_binding IS NULL)
      OR ((provider_dispatch_binding)::text ~ '^[a-z][a-z0-9._-]{0,31}:sha256:[0-9a-f]{64}$'));
