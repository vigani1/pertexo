-- Automatically create bounded workflow-input enforcement batches. PostgreSQL
-- owns both the retention cutoff and durable workspace scan progress.

CREATE TABLE app.retention_schedule_state (
  workspace_id uuid PRIMARY KEY,
  retention_kind varchar(32) NOT NULL DEFAULT 'workflow_run_input',
  next_scan_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_scanned_at timestamptz,
  last_cutoff_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT retention_schedule_state_workspace_fk FOREIGN KEY (workspace_id)
    REFERENCES app.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT retention_schedule_state_kind_valid
    CHECK (retention_kind='workflow_run_input')
);
CREATE INDEX retention_schedule_state_due_idx
  ON app.retention_schedule_state(next_scan_at,workspace_id);

CREATE FUNCTION app.provision_retention_schedule_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  INSERT INTO app.retention_schedule_state(workspace_id)
  VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER workspaces_provision_retention_schedule
  AFTER INSERT ON app.workspaces FOR EACH ROW
  EXECUTE FUNCTION app.provision_retention_schedule_state();

INSERT INTO app.retention_schedule_state(workspace_id)
SELECT workspace.id FROM app.workspaces workspace ON CONFLICT DO NOTHING;

CREATE FUNCTION app.schedule_workflow_run_input_retention(p_limit integer)
RETURNS TABLE(scanned_count integer,scheduled_count integer,cutoff_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_batch_id uuid;
  v_cutoff_at timestamptz:=clock_timestamp();
  v_idempotency_key varchar(128):='scheduled:workflow_run_input:'
    ||to_char(v_cutoff_at AT TIME ZONE 'UTC','YYYY-MM-DD');
  v_next_scan_at timestamptz:=(date_trunc('day',v_cutoff_at AT TIME ZONE 'UTC')
    AT TIME ZONE 'UTC')+interval '1 day';
  v_prior_workspace text:=current_setting('app.workspace_id',true);
  v_scanned_count integer:=0;
  v_scheduled_count integer:=0;
  v_state record;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'invalid retention schedule limit' USING ERRCODE='22023';
  END IF;
  FOR v_state IN
    SELECT state.workspace_id FROM app.retention_schedule_state state
    JOIN app.workspaces workspace ON workspace.id=state.workspace_id
    WHERE state.next_scan_at<=v_cutoff_at
    ORDER BY state.next_scan_at,state.workspace_id LIMIT p_limit
    FOR UPDATE OF workspace,state SKIP LOCKED
  LOOP
    v_scanned_count:=v_scanned_count+1;
    PERFORM set_config('app.workspace_id',v_state.workspace_id::text,true);
    IF EXISTS (
      SELECT 1 FROM app.workflow_runs run
      WHERE run.workspace_id=v_state.workspace_id AND run.input_ref IS NOT NULL
        AND run.input_ref_expires_at<=v_cutoff_at
    ) AND NOT EXISTS (
      SELECT 1 FROM app.retention_batches batch
      WHERE batch.workspace_id=v_state.workspace_id AND NOT batch.dry_run
        AND batch.status<>'completed'
    ) AND NOT EXISTS (
      SELECT 1 FROM app.retention_batches batch
      WHERE batch.workspace_id=v_state.workspace_id
        AND batch.idempotency_key=v_idempotency_key
    ) THEN
      v_batch_id:=gen_random_uuid();
      PERFORM app.start_retention_batch(v_batch_id,v_state.workspace_id,
        v_idempotency_key,'workflow_run_input',v_cutoff_at,false,
        'retention-scheduler','scheduled 30-day workflow input retention');
      v_scheduled_count:=v_scheduled_count+1;
    END IF;
    UPDATE app.retention_schedule_state SET next_scan_at=v_next_scan_at,
      last_scanned_at=v_cutoff_at,last_cutoff_at=v_cutoff_at,
      updated_at=clock_timestamp() WHERE workspace_id=v_state.workspace_id;
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN QUERY SELECT v_scanned_count,v_scheduled_count,v_cutoff_at;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

REVOKE ALL ON app.retention_schedule_state
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{maintenance_role}},{{lifecycle_command_role}};
REVOKE ALL ON FUNCTION app.provision_retention_schedule_state(),
  app.schedule_workflow_run_input_retention(integer)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{maintenance_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.schedule_workflow_run_input_retention(integer)
  TO {{maintenance_role}};
