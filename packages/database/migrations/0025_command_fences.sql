-- Commands check authority and retention in TypeScript. The manual command
-- still serializes its workspace/key with a transaction advisory lock.
DROP TRIGGER manual_start_writer_fence ON app.workflow_runs;
DROP FUNCTION app.enforce_manual_start_writer();
DROP FUNCTION app.lock_manual_workflow_run_start(uuid, uuid, text, text);

DROP TRIGGER artifact_link_preview_retention ON app.artifact_links;
DROP FUNCTION app.enforce_preview_artifact_retention();

DROP TRIGGER workspace_lifecycle_operations_canonical_time
  ON app.workspace_lifecycle_operations;
DROP FUNCTION app.canonicalize_workspace_lifecycle_operation_time();

ALTER TABLE app.run_checkpoints DROP COLUMN last_transition_fingerprint;

-- The input-case writer fences were removed in 0009. Outbox payload checksums
-- stay: they detect changed payloads under a reused delivery identity and let
-- a consumer verify a redelivery or recover an unknown commit.
