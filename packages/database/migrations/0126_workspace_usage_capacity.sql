-- ADR 057: expose only a scoped reservation count, never reservation rows.
CREATE INDEX workflow_run_active_admissions_workspace_idx
  ON app.workflow_run_active_admissions(workspace_id);

CREATE FUNCTION app.workspace_reserved_active_slot_count(p_workspace_id uuid)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  IF p_workspace_id IS NULL OR
    nullif(current_setting('app.workspace_id',true),'')::uuid
      IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  RETURN (SELECT count(*)::integer FROM app.workflow_run_active_admissions
    WHERE workspace_id=p_workspace_id);
END $$;
ALTER FUNCTION app.workspace_reserved_active_slot_count(uuid) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.workspace_reserved_active_slot_count(uuid)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{lifecycle_command_role}},{{operator_role}};
GRANT EXECUTE ON FUNCTION app.workspace_reserved_active_slot_count(uuid)
  TO {{api_runtime_role}};
