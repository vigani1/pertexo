-- ADR 069: one storage region. Workspace lifecycle commands are recorded only
-- in the database, so the object-store ledger's repair, inventory and legal-hold
-- command functions go. New runs no longer wait on a cross-region replica.

DROP FUNCTION app.assert_regional_write_admission();
DROP FUNCTION app.record_regional_replica_lag(varchar,varchar,bigint,integer);
DROP TABLE app.regional_write_admission;

DROP FUNCTION app.enumerate_committed_tenant_artifacts(uuid,uuid,integer);
DROP FUNCTION app.enumerate_workspace_control_anchors(uuid,integer);
DROP FUNCTION app.project_workspace_legal_hold(
  uuid,bigint,uuid,varchar,uuid,char,char,varchar,varchar,varchar,timestamptz
);
DROP FUNCTION app.validate_workspace_legal_hold_command(uuid,varchar,uuid);
DROP FUNCTION app.validate_workspace_deletion_command(uuid,varchar,timestamptz);
DROP FUNCTION app.read_workspace_control_command(uuid,uuid);
DROP FUNCTION app.read_workspace_lifecycle_control_command(uuid,uuid,bigint);
DROP FUNCTION app.workspace_purge_completion_repair_command_id(uuid);
DROP FUNCTION app.workspace_purge_repair_command_id(uuid);
