-- 0081 fences future provisioning; reconcile workspaces committed by the old race.
-- Match apply_instance_capacity: singleton, artifact counters, entitlement versions.
DO $$
DECLARE
  limits app.instance_capacity%ROWTYPE;
  prior_workspace text;
  workspace uuid;
BEGIN
  SELECT * INTO STRICT limits FROM app.instance_capacity FOR UPDATE;
  UPDATE app.workspace_artifact_capacity
     SET artifact_count_limit=limits.artifact_count_limit,updated_at=clock_timestamp()
   WHERE artifact_count_limit IS DISTINCT FROM limits.artifact_count_limit;
  prior_workspace := current_setting('app.workspace_id',true);
  FOR workspace IN SELECT id FROM app.workspaces ORDER BY id LOOP
    PERFORM set_config('app.workspace_id',workspace::text,true);
    UPDATE app.workspace_execution_entitlement_versions
       SET active_run_limit=limits.active_run_limit,queued_run_limit=limits.queued_run_limit
     WHERE workspace_id=workspace
       AND (active_run_limit IS DISTINCT FROM limits.active_run_limit
         OR queued_run_limit IS DISTINCT FROM limits.queued_run_limit);
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
END $$;
