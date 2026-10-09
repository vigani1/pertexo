-- Every published version carries its executable. Before launch there is one
-- stored format for each thing (ADR 069); a version stored with only a
-- checksum (the retained "V1" shape) could never run, and nothing publishes
-- one. The executable's format number goes with it. The worker read policy
-- only narrowed reads to executable versions, which every version now is, so
-- the workspace policy covers it.

DROP POLICY workflow_versions_worker_execution_read ON app.workflow_versions;
DROP FUNCTION app.lock_workflow_run_replay_version(uuid, uuid, uuid);

ALTER TABLE app.workflow_versions
  DROP CONSTRAINT workflow_versions_checksum_format,
  DROP CONSTRAINT workflow_versions_executable_bounded,
  DROP COLUMN executable_schema_version,
  ALTER COLUMN executable_json SET NOT NULL,
  ADD CONSTRAINT workflow_versions_checksum_format
    CHECK ((checksum)::text ~ '^wf:v2:sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT workflow_versions_executable_object
    CHECK (jsonb_typeof(executable_json) = 'object'
      AND octet_length(executable_json::text) <= 1048576);

CREATE FUNCTION app.lock_workflow_run_replay_version(p_workspace_id uuid, p_workflow_id uuid, p_workflow_version_id uuid) RETURNS TABLE(id uuid, workspace_id uuid, workflow_id uuid, version_number integer, schema_version integer, checksum character varying, executable_json jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF p_workspace_id IS NULL OR p_workflow_id IS NULL
     OR p_workflow_version_id IS NULL THEN
    RAISE EXCEPTION 'workflow replay version lock arguments are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF p_workspace_id::text IS DISTINCT FROM
      NULLIF(current_setting('app.workspace_id', true), '') THEN
    RAISE EXCEPTION 'workflow replay workspace context mismatch'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT workflow_version.id,
           workflow_version.workspace_id,
           workflow_version.workflow_id,
           workflow_version.version_number,
           workflow_version.schema_version,
           workflow_version.checksum,
           workflow_version.executable_json
      FROM app.workflow_versions AS workflow_version
     WHERE workflow_version.workspace_id = p_workspace_id
       AND workflow_version.workflow_id = p_workflow_id
       AND workflow_version.id = p_workflow_version_id
     FOR SHARE;
END;
$$;
REVOKE ALL ON FUNCTION app.lock_workflow_run_replay_version(uuid, uuid, uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_workflow_run_replay_version(uuid, uuid, uuid) TO {{app_role}};
