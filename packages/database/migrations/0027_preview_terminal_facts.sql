-- Preview terminal audit and usage facts commit with the terminal transition.
-- The worker may append only tenant-scoped facts; serving roles cannot update
-- or delete immutable audit/metering history.

ALTER POLICY audit_events_workspace_insert ON app.audit_events
  TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}};
GRANT INSERT ON app.audit_events TO {{worker_runtime_role}};

CREATE TABLE app.usage_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  category varchar(64) NOT NULL,
  quantity bigint NOT NULL,
  resource_type varchar(64) NOT NULL,
  resource_id uuid NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT usage_events_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES app.workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT usage_events_category_format
    CHECK (category ~ '^[a-z][a-z0-9._:-]{0,63}$'),
  CONSTRAINT usage_events_quantity_positive CHECK (quantity > 0),
  CONSTRAINT usage_events_resource_type_format
    CHECK (resource_type ~ '^[a-z][a-z0-9._:-]{0,63}$'),
  CONSTRAINT usage_events_idempotency_key_format
    CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT usage_events_metadata_bounded
    CHECK (octet_length(metadata::text) <= 4096),
  CONSTRAINT usage_events_workspace_idempotency_unique
    UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX usage_events_workspace_period_idx
  ON app.usage_events (workspace_id, occurred_at DESC, id);
CREATE INDEX usage_events_resource_idx
  ON app.usage_events (workspace_id, resource_type, resource_id, id);

-- A deployment may encounter previews that reached a terminal state under the
-- preceding migration head. Backfill one safe audit fact and one idempotent
-- usage fact for those rows before serving roles can observe the new table.
-- The migration owner temporarily bypasses forced RLS only inside this
-- transaction; FORCE is restored before runtime policies and grants are set.
ALTER TABLE app.preview_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.preview_attempts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events NO FORCE ROW LEVEL SECURITY;

INSERT INTO app.audit_events (
  id, workspace_id, actor_user_id, action, target_type, target_id, trace_id,
  metadata, occurred_at
)
SELECT gen_random_uuid(),
       preview.workspace_id,
       preview.actor_user_id,
       'preview.execution_terminal',
       'preview-run',
       preview.id,
       CASE WHEN preview.traceparent IS NULL THEN NULL
            ELSE substring(preview.traceparent FROM 4 FOR 32) END,
       jsonb_build_object(
         'schemaVersion', 1,
         'status', preview.status,
         'workflowId', preview.workflow_id,
         'nodeId', preview.node_id,
         'definitionKey', preview.definition_key,
         'definitionVersion', preview.definition_version,
         'executorKey', preview.executor_key,
         'executorVersion', preview.executor_version,
         'sideEffectClass', preview.side_effect_class,
         'mayContactProvider', preview.may_contact_provider,
         'mayCauseExternalSideEffect',
           preview.may_cause_external_side_effect,
         'previewAttemptId', attempt.id
       ),
       preview.completed_at
  FROM app.preview_runs preview
  JOIN app.preview_attempts attempt
    ON attempt.workspace_id = preview.workspace_id
   AND attempt.preview_run_id = preview.id
 WHERE preview.status IN (
   'succeeded', 'failed', 'canceled', 'timed_out', 'outcome_unknown'
 )
   AND NOT EXISTS (
     SELECT 1
       FROM app.audit_events audit
      WHERE audit.workspace_id = preview.workspace_id
        AND audit.action = 'preview.execution_terminal'
        AND audit.target_type = 'preview-run'
        AND audit.target_id = preview.id
   );

INSERT INTO app.usage_events (
  id, workspace_id, category, quantity, resource_type, resource_id,
  idempotency_key, metadata, occurred_at
)
SELECT gen_random_uuid(),
       preview.workspace_id,
       'preview_execution',
       1,
       'preview-run',
       preview.id,
       'preview-terminal:' || preview.id::text,
       jsonb_build_object(
         'schemaVersion', 1,
         'status', preview.status,
         'definitionKey', preview.definition_key,
         'executorKey', preview.executor_key,
         'sideEffectClass', preview.side_effect_class
       ),
       preview.completed_at
  FROM app.preview_runs preview
 WHERE preview.status IN (
   'succeeded', 'failed', 'canceled', 'timed_out', 'outcome_unknown'
 )
ON CONFLICT (workspace_id, idempotency_key) DO NOTHING;

ALTER TABLE app.preview_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.preview_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events FORCE ROW LEVEL SECURITY;

ALTER TABLE app.usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.usage_events FORCE ROW LEVEL SECURITY;

CREATE POLICY usage_events_workspace_select ON app.usage_events
  FOR SELECT TO {{owner_role}}, {{api_runtime_role}}, {{worker_runtime_role}}
  USING (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  );
CREATE POLICY usage_events_workspace_insert ON app.usage_events
  FOR INSERT TO {{owner_role}}, {{worker_runtime_role}}
  WITH CHECK (
    workspace_id::text = NULLIF(current_setting('app.workspace_id', true), '')
  );

ALTER TABLE app.usage_events OWNER TO {{owner_role}};
REVOKE ALL ON app.usage_events
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
GRANT SELECT ON app.usage_events TO {{api_runtime_role}}, {{worker_runtime_role}};
GRANT INSERT ON app.usage_events TO {{worker_runtime_role}};
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.usage_events
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
