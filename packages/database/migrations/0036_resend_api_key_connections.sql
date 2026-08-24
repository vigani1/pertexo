ALTER TABLE app.connections
  DROP CONSTRAINT connections_auth_type_valid,
  ADD CONSTRAINT connections_auth_type_valid
    CHECK (auth_type IN ('http_headers', 'slack_bot_token', 'resend_api_key'));

ALTER TABLE app.node_runs
  ADD COLUMN provider_dispatch_binding varchar(128),
  ADD CONSTRAINT node_runs_provider_dispatch_binding_format CHECK (
    provider_dispatch_binding IS NULL
    OR provider_dispatch_binding ~ '^[a-z][a-z0-9._-]{0,31}:v[1-9][0-9]{0,2}:sha256:[0-9a-f]{64}$'
  );

ALTER TABLE app.preview_attempts
  ADD COLUMN provider_dispatch_binding varchar(128),
  ADD CONSTRAINT preview_attempts_provider_dispatch_binding_format CHECK (
    provider_dispatch_binding IS NULL
    OR provider_dispatch_binding ~ '^[a-z][a-z0-9._-]{0,31}:v[1-9][0-9]{0,2}:sha256:[0-9a-f]{64}$'
  );

CREATE FUNCTION app.connection_dispatch_fence_current(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_expected_provider_key text,
  p_expected_auth_type text,
  p_secret_version_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = on
AS $$
DECLARE
  fence_current boolean := false;
  workspace_active boolean := false;
BEGIN
  IF nullif(current_setting('app.workspace_id', true), '')::uuid
       IS DISTINCT FROM p_workspace_id THEN
    RETURN false;
  END IF;

  SELECT true INTO workspace_active
  FROM app.workspaces workspace
  WHERE workspace.id = p_workspace_id
    AND workspace.status = 'active'
  LIMIT 1
  FOR SHARE OF workspace;

  IF NOT coalesce(workspace_active, false) THEN
    RETURN false;
  END IF;

  SELECT true INTO fence_current
  FROM app.workspaces workspace
  JOIN app.connections connection_record
    ON connection_record.workspace_id = workspace.id
  WHERE workspace.id = p_workspace_id
    AND workspace.status = 'active'
    AND connection_record.id = p_connection_id
    AND connection_record.provider_key = p_expected_provider_key
    AND connection_record.auth_type = p_expected_auth_type
    AND connection_record.current_secret_version_id = p_secret_version_id
    AND connection_record.status = 'active'
  LIMIT 1
  FOR SHARE OF connection_record;

  RETURN coalesce(fence_current, false);
END;
$$;

ALTER FUNCTION app.connection_dispatch_fence_current(uuid, uuid, text, text, uuid)
  OWNER TO {{owner_role}};

REVOKE ALL ON FUNCTION
  app.connection_dispatch_fence_current(uuid, uuid, text, text, uuid)
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};

GRANT EXECUTE ON FUNCTION
  app.connection_dispatch_fence_current(uuid, uuid, text, text, uuid)
  TO {{worker_runtime_role}};

GRANT UPDATE (provider_dispatch_binding)
  ON app.node_runs, app.preview_attempts TO {{worker_runtime_role}};
