CREATE FUNCTION app.lock_workspace_run_admission(p_workspace_id uuid)
RETURNS varchar
LANGUAGE sql
SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp
SET row_security=on
AS $$
  SELECT workspace.status
    FROM app.workspaces workspace
   WHERE workspace.id=p_workspace_id
   FOR SHARE
$$;

REVOKE ALL ON FUNCTION app.lock_workspace_run_admission(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_workspace_run_admission(uuid)
  TO {{api_runtime_role}},{{worker_runtime_role}};

CREATE FUNCTION app.lock_workflow_failure_notification_policy(
  p_workspace_id uuid,p_workflow_id uuid
) RETURNS TABLE(
  destination_id uuid,current_config_version integer,destination_status varchar,
  kind varchar,side_effect_class varchar,connection_id uuid
) LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
  SELECT destination.id,destination.current_config_version,destination.status,
         version.kind,version.side_effect_class,
         CASE WHEN jsonb_typeof(version.config)='object'
           AND version.config?'connectionId'
           AND (version.config->>'connectionId')~
             '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           THEN (version.config->>'connectionId')::uuid ELSE NULL END
    FROM app.workflow_failure_notification_policies policy
    JOIN app.failure_notification_destinations destination
      ON destination.workspace_id=policy.workspace_id
     AND destination.id=policy.destination_id
    JOIN app.failure_notification_destination_versions version
      ON version.workspace_id=destination.workspace_id
     AND version.destination_id=destination.id
     AND version.version=destination.current_config_version
   WHERE policy.workspace_id=p_workspace_id AND policy.workflow_id=p_workflow_id
   FOR SHARE OF policy,destination
$$;

REVOKE ALL ON FUNCTION app.lock_workflow_failure_notification_policy(uuid,uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_workflow_failure_notification_policy(uuid,uuid)
  TO {{api_runtime_role}},{{worker_runtime_role}};

GRANT INSERT ON app.workflow_runs,app.run_events,app.run_checkpoints,
  app.idempotency_records TO {{worker_runtime_role}};
GRANT UPDATE(status,result_ref,updated_at) ON app.idempotency_records
  TO {{worker_runtime_role}};
