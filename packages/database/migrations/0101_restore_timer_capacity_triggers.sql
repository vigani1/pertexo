-- Timer parking/resumption changes capacity without changing run status.
DROP TRIGGER workflow_runs_execution_admission ON app.workflow_runs;
CREATE TRIGGER workflow_runs_execution_admission BEFORE INSERT OR UPDATE OF workspace_id,status,execution_entitlement_version,human_wait_started_at,timed_wait_started_at ON app.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_workflow_run_admission();
--> statement-breakpoint
DROP TRIGGER workflow_runs_refresh_execution_admission ON app.workflow_runs;
CREATE TRIGGER workflow_runs_refresh_execution_admission AFTER INSERT OR UPDATE OF workspace_id,status,execution_entitlement_version,human_wait_started_at,timed_wait_started_at ON app.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION app.refresh_workflow_run_admission_counters();
