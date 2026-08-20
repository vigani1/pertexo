-- Phase 2 workflow authoring persistence. Graph semantics and canonical
-- checksum calculation remain application-owned; PostgreSQL protects tenant,
-- revision, content identity, publication atomicity, and immutability.

CREATE TABLE app.workflows (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  name varchar(128) NOT NULL,
  lifecycle_status varchar(32) NOT NULL DEFAULT 'active',
  activation_status varchar(32) NOT NULL DEFAULT 'inactive',
  published_version_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL
    DEFAULT date_trunc('milliseconds', clock_timestamp()),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflows_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES app.workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT workflows_created_by_fk
    FOREIGN KEY (created_by) REFERENCES app.users (id) ON DELETE RESTRICT,
  CONSTRAINT workflows_workspace_identity_unique UNIQUE (workspace_id, id),
  CONSTRAINT workflows_name_nonempty
    CHECK (length(btrim(name)) BETWEEN 1 AND 128),
  CONSTRAINT workflows_lifecycle_status_valid
    CHECK (lifecycle_status IN ('active', 'archived')),
  CONSTRAINT workflows_activation_status_valid
    CHECK (activation_status = 'inactive'),
  CONSTRAINT workflows_created_at_millisecond_precision
    CHECK (created_at = date_trunc('milliseconds', created_at))
);

CREATE INDEX workflows_workspace_created_idx
  ON app.workflows (workspace_id, created_at, id);
CREATE INDEX workflows_workspace_name_idx
  ON app.workflows (workspace_id, name, id);

CREATE TABLE app.workflow_drafts (
  workflow_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  schema_version integer NOT NULL,
  graph_json jsonb NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_drafts_workflow_workspace_fk
    FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES app.workflows (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_drafts_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES app.users (id) ON DELETE RESTRICT,
  CONSTRAINT workflow_drafts_revision_positive CHECK (revision > 0),
  CONSTRAINT workflow_drafts_schema_version_supported CHECK (schema_version = 1),
  CONSTRAINT workflow_drafts_graph_object CHECK (jsonb_typeof(graph_json) = 'object'),
  -- JSONB text adds whitespace; the application enforces the exact compact
  -- 1 MiB limit and this deliberately looser check is defense in depth.
  CONSTRAINT workflow_drafts_graph_bounded CHECK (octet_length(graph_json::text) <= 2097152)
);

CREATE INDEX workflow_drafts_workspace_idx
  ON app.workflow_drafts (workspace_id, workflow_id);

CREATE TABLE app.workflow_versions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  version_number integer NOT NULL,
  schema_version integer NOT NULL,
  graph_json jsonb NOT NULL,
  checksum varchar(77) NOT NULL,
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workflow_versions_workflow_workspace_fk
    FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES app.workflows (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT workflow_versions_published_by_fk
    FOREIGN KEY (published_by) REFERENCES app.users (id) ON DELETE RESTRICT,
  CONSTRAINT workflow_versions_workspace_identity_unique
    UNIQUE (workspace_id, workflow_id, id),
  CONSTRAINT workflow_versions_number_unique UNIQUE (workflow_id, version_number),
  CONSTRAINT workflow_versions_checksum_unique UNIQUE (workflow_id, checksum),
  CONSTRAINT workflow_versions_number_positive CHECK (version_number > 0),
  CONSTRAINT workflow_versions_schema_version_supported CHECK (schema_version = 1),
  CONSTRAINT workflow_versions_graph_object CHECK (jsonb_typeof(graph_json) = 'object'),
  CONSTRAINT workflow_versions_graph_bounded CHECK (octet_length(graph_json::text) <= 2097152),
  CONSTRAINT workflow_versions_checksum_format
    CHECK (checksum ~ '^wf:v1:sha256:[0-9a-f]{64}$')
);

CREATE INDEX workflow_versions_workspace_workflow_idx
  ON app.workflow_versions (workspace_id, workflow_id, version_number DESC);

CREATE INDEX outbox_events_dispatch_job_due_idx
  ON app.outbox_events (job_name, available_at, id)
  WHERE published_at IS NULL AND failed_at IS NULL;

ALTER TABLE app.workflows
  ADD CONSTRAINT workflows_published_version_workspace_fk
  FOREIGN KEY (workspace_id, id, published_version_id)
  REFERENCES app.workflow_versions (workspace_id, workflow_id, id)
  ON DELETE RESTRICT;

CREATE FUNCTION app.reject_workflow_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'workflow versions are immutable' USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER workflow_versions_immutable
  BEFORE UPDATE OR DELETE ON app.workflow_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_workflow_version_mutation();

ALTER TABLE app.workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflows FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY workflows_workspace_scope ON app.workflows
  FOR ALL TO {{owner_role}}, {{api_runtime_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));
CREATE POLICY workflow_drafts_workspace_scope ON app.workflow_drafts
  FOR ALL TO {{owner_role}}, {{api_runtime_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));
CREATE POLICY workflow_versions_workspace_scope ON app.workflow_versions
  FOR ALL TO {{owner_role}}, {{api_runtime_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));

-- The owner-executed atomic creator remains subject to the same tenant context
-- while inspecting authorization and appending command facts.
ALTER POLICY workspace_memberships_workspace_scope ON app.workspace_memberships
  TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}};
ALTER POLICY audit_events_workspace_select ON app.audit_events
  TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}};
ALTER POLICY audit_events_workspace_insert ON app.audit_events
  TO {{owner_role}}, {{api_runtime_role}};
ALTER POLICY idempotency_records_workspace_scope ON app.idempotency_records
  TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}};

CREATE FUNCTION app.create_workflow_with_draft(
  p_workflow_id uuid,
  p_workspace_id uuid,
  p_name varchar(128),
  p_actor_id uuid,
  p_schema_version integer,
  p_graph_json jsonb,
  p_key_hash char(64),
  p_request_hash char(64),
  p_request_id varchar(128),
  p_trace_id varchar(128)
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_claim_id uuid;
  v_existing record;
BEGIN
  IF p_workspace_id::text IS DISTINCT FROM NULLIF(current_setting('app.workspace_id', true), '')
     OR p_actor_id::text IS DISTINCT FROM NULLIF(current_setting('app.actor_id', true), '') THEN
    RAISE EXCEPTION 'workflow context mismatch' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_memberships membership
    JOIN app.workspaces workspace ON workspace.id = membership.workspace_id
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = p_actor_id
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin', 'builder')
      AND workspace.status = 'active'
  ) THEN
    RAISE EXCEPTION 'workflow author is not active' USING ERRCODE = '42501';
  END IF;

  INSERT INTO app.idempotency_records
    (id, workspace_id, operation, scope, key_hash, request_hash, status, resource_id, result_ref)
  VALUES
    (gen_random_uuid(), p_workspace_id, 'workflow.create', p_actor_id::text,
     p_key_hash, p_request_hash, 'in_progress', p_workflow_id, '{}'::jsonb)
  ON CONFLICT (workspace_id, operation, scope, key_hash) DO NOTHING
  RETURNING id INTO v_claim_id;

  IF v_claim_id IS NULL THEN
    SELECT request_hash, status, result_ref INTO v_existing
    FROM app.idempotency_records
    WHERE workspace_id = p_workspace_id AND operation = 'workflow.create'
      AND scope = p_actor_id::text AND key_hash = p_key_hash
    FOR UPDATE;
    IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'workflow create idempotency conflict' USING ERRCODE = '23505';
    END IF;
    IF v_existing.status <> 'completed' THEN
      RAISE EXCEPTION 'workflow create idempotency record incomplete' USING ERRCODE = '55000';
    END IF;
    RETURN (v_existing.result_ref->>'workflowId')::uuid;
  END IF;

  INSERT INTO app.workflows (
    id, workspace_id, name, lifecycle_status, activation_status, created_by
  ) VALUES (p_workflow_id, p_workspace_id, p_name, 'active', 'inactive', p_actor_id);
  INSERT INTO app.workflow_drafts (
    workflow_id, workspace_id, revision, schema_version, graph_json, updated_by
  ) VALUES (p_workflow_id, p_workspace_id, 1, p_schema_version, p_graph_json, p_actor_id);
  INSERT INTO app.audit_events
    (id, workspace_id, actor_user_id, action, target_type, target_id,
     request_id, trace_id, metadata)
  VALUES
    (gen_random_uuid(), p_workspace_id, p_actor_id, 'workflow.created',
     'workflow', p_workflow_id, p_request_id, p_trace_id, '{"revision":1}'::jsonb);
  UPDATE app.idempotency_records
  SET status = 'completed', result_ref = jsonb_build_object('workflowId', p_workflow_id),
      updated_at = clock_timestamp()
  WHERE id = v_claim_id;
  RETURN p_workflow_id;
END;
$function$;

REVOKE ALL ON FUNCTION app.create_workflow_with_draft(uuid, uuid, varchar, uuid, integer, jsonb, char, char, varchar, varchar)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_workflow_with_draft(uuid, uuid, varchar, uuid, integer, jsonb, char, char, varchar, varchar)
  TO {{api_runtime_role}};

REVOKE ALL ON app.workflows, app.workflow_drafts, app.workflow_versions
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};

GRANT SELECT ON app.workflows, app.workflow_drafts, app.workflow_versions
  TO {{api_runtime_role}};
GRANT UPDATE (name, lifecycle_status, activation_status, published_version_id, updated_at)
  ON app.workflows TO {{api_runtime_role}};
GRANT UPDATE (revision, schema_version, graph_json, updated_by, updated_at)
  ON app.workflow_drafts TO {{api_runtime_role}};
GRANT INSERT ON app.workflow_versions TO {{api_runtime_role}};

REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.workflows, app.workflow_drafts
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.workflow_versions
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
REVOKE ALL ON FUNCTION app.reject_workflow_version_mutation()
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
