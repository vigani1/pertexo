-- Keep replay source/version validation serialized without widening the API's
-- arbitrary UPDATE authority. PostgreSQL requires UPDATE privilege for
-- SELECT ... FOR SHARE on rows; these owner-defined helpers expose only the
-- fields and locks needed by the replay acceptance transaction.

CREATE FUNCTION app.lock_workflow_run_replay_source(
  p_workspace_id uuid,
  p_source_run_id uuid
) RETURNS TABLE(workflow_id uuid, lifecycle_status varchar)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
SET row_security = on
AS $function$
BEGIN
  IF p_workspace_id IS NULL OR p_source_run_id IS NULL THEN
    RAISE EXCEPTION 'workflow replay source lock arguments are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF p_workspace_id::text IS DISTINCT FROM
      NULLIF(current_setting('app.workspace_id', true), '') THEN
    RAISE EXCEPTION 'workflow replay workspace context mismatch'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT run.workflow_id, workflow.lifecycle_status
      FROM app.workflow_runs AS run
      JOIN app.workflows AS workflow
        ON workflow.workspace_id = run.workspace_id
       AND workflow.id = run.workflow_id
     WHERE run.workspace_id = p_workspace_id
       AND run.id = p_source_run_id
     FOR SHARE OF run, workflow;
END;
$function$;

CREATE FUNCTION app.lock_workflow_run_replay_version(
  p_workspace_id uuid,
  p_workflow_id uuid,
  p_workflow_version_id uuid
) RETURNS TABLE(
  id uuid,
  workspace_id uuid,
  workflow_id uuid,
  version_number integer,
  schema_version integer,
  checksum varchar,
  executable_schema_version integer,
  executable_json jsonb,
  compatibility_release_epoch integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
SET row_security = on
AS $function$
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
           workflow_version.executable_schema_version,
           workflow_version.executable_json,
           workflow_version.compatibility_release_epoch
      FROM app.workflow_versions AS workflow_version
     WHERE workflow_version.workspace_id = p_workspace_id
       AND workflow_version.workflow_id = p_workflow_id
       AND workflow_version.id = p_workflow_version_id
     FOR SHARE;
END;
$function$;

REVOKE ALL ON FUNCTION app.lock_workflow_run_replay_source(uuid, uuid)
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}},
    {{dispatcher_role}}, {{maintenance_role}}, {{lifecycle_command_role}},
    {{operator_role}};
REVOKE ALL ON FUNCTION app.lock_workflow_run_replay_version(uuid, uuid, uuid)
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}},
    {{dispatcher_role}}, {{maintenance_role}}, {{lifecycle_command_role}},
    {{operator_role}};

GRANT EXECUTE ON FUNCTION app.lock_workflow_run_replay_source(uuid, uuid)
  TO {{api_runtime_role}};
GRANT EXECUTE ON FUNCTION app.lock_workflow_run_replay_version(uuid, uuid, uuid)
  TO {{api_runtime_role}};
