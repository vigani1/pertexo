-- 0100 missed timer-only writes. 0101 repaired future writes; reconcile any
-- existing drift from the same durable slot definition used by admission.
DO $$
DECLARE
  workspace uuid;
  prior_workspace text := current_setting('app.workspace_id',true);
BEGIN
  -- Match admission's workspace -> counter order and exclude concurrent run
  -- transitions while each workspace's durable counts are read and stored.
  FOR workspace IN SELECT id FROM app.workspaces ORDER BY id FOR UPDATE LOOP
    PERFORM set_config('app.workspace_id',workspace::text,true);
    UPDATE app.workspace_execution_admission_counters counter
       SET active_runs=slots.active_runs, queued_runs=slots.queued_runs,
           reconciled_at=clock_timestamp()
      FROM app.workflow_run_slot_counts(workspace) slots
     WHERE counter.workspace_id=workspace
       AND (counter.active_runs,counter.queued_runs)
           IS DISTINCT FROM (slots.active_runs,slots.queued_runs);
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
END $$;
