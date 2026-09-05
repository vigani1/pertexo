CREATE FUNCTION app.release_workspace_purge_step(
  p_job_id uuid,p_lease_token uuid,p_lease_fence bigint
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_changed integer;
BEGIN
  IF p_job_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_lease_fence<1 THEN
    RAISE EXCEPTION 'invalid workspace purge step release' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_purge_transition','on',true);
  UPDATE app.workspace_purge_steps SET status='pending',lease_owner=NULL,
    lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    updated_at=clock_timestamp()
  WHERE job_id=p_job_id AND status='running' AND lease_token=p_lease_token
    AND lease_fence=p_lease_fence AND lease_expires_at>clock_timestamp();
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  RETURN v_changed=1;
END $$;

REVOKE ALL ON FUNCTION app.release_workspace_purge_step(uuid,uuid,bigint)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.release_workspace_purge_step(uuid,uuid,bigint)
  TO {{maintenance_role}};
