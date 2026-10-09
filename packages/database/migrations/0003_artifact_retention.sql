-- Run-artifact retention and preview cleanup run in TypeScript under the
-- maintenance role (src/lifecycle/run-artifact-retention.ts and
-- preview-retention.ts). Artifact status and its retry time keep workers
-- apart, so the workspace control fence, the destruction capability rows and
-- their guard go.

DROP FUNCTION app.find_due_run_artifact_retention(integer);
DROP FUNCTION app.prepare_run_artifact_retention(uuid, uuid, bigint, character);
DROP FUNCTION app.defer_run_artifact_retention(uuid, uuid, bigint, character);
DROP FUNCTION app.complete_run_artifact_retention(uuid, uuid, bigint, character);
DROP FUNCTION app.find_due_preview_cleanup(integer);
DROP FUNCTION app.prepare_preview_cleanup_step(uuid, uuid, integer, bigint, character);
DROP FUNCTION app.complete_preview_artifact_cleanup(uuid, uuid, bigint, character);
DROP FUNCTION app.finish_preview_cleanup(uuid, uuid, bigint, character);
DROP FUNCTION app.complete_preview_cleanup(uuid, uuid);

DROP TRIGGER artifacts_preview_destruction_guard ON app.artifacts;
DROP FUNCTION app.guard_preview_artifact_destruction();
DROP TABLE pertexo_internal.preview_retention_transition_capabilities;

DROP FUNCTION app.lock_workspace_control_ledger(uuid);
ALTER TABLE app.workspaces
  DROP COLUMN retention_control_sequence,
  DROP COLUMN retention_control_hash;

GRANT UPDATE (status, retention_retry_at, deleted_at, updated_at)
  ON app.artifacts TO {{maintenance_role}};
GRANT UPDATE (updated_at) ON app.preview_runs TO {{maintenance_role}};
GRANT EXECUTE ON FUNCTION app.jsonb_references_artifact(jsonb, uuid)
  TO {{maintenance_role}};
