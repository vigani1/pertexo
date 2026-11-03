CREATE OR REPLACE FUNCTION app.provision_workspace_execution_admission() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE prior_workspace text;
BEGIN
  -- Capacity is always locked before provisioning entitlement/counter rows. The
  -- updater takes this same singleton lock before scanning committed workspaces.
  PERFORM 1 FROM app.instance_capacity FOR SHARE;
  prior_workspace := current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',NEW.id::text,true);
  INSERT INTO app.workspace_execution_entitlement_versions (
    workspace_id,version,status,active_run_limit,queued_run_limit,effective_at
  ) SELECT NEW.id,1,'active',capacity.active_run_limit,capacity.queued_run_limit,'-infinity'::timestamptz
      FROM app.instance_capacity capacity;
  INSERT INTO app.workspace_execution_entitlements(workspace_id,current_version)
    VALUES (NEW.id,1);
  INSERT INTO app.workspace_execution_admission_counters(workspace_id)
    VALUES (NEW.id);
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RETURN NEW;
END $$;--> statement-breakpoint
