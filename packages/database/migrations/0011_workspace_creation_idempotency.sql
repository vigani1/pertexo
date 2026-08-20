CREATE TABLE app.workspace_creation_idempotency_records (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES app.users(id),
  operation varchar(64) NOT NULL,
  key_hash char(64) NOT NULL,
  request_hash char(64) NOT NULL,
  status varchar(16) NOT NULL,
  resource_id uuid REFERENCES app.workspaces(id),
  result_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_creation_idempotency_active_key_unique
    UNIQUE (actor_user_id, operation, key_hash),
  CONSTRAINT workspace_creation_idempotency_operation_format
    CHECK (operation ~ '^[a-z][a-z0-9.]{0,63}$'),
  CONSTRAINT workspace_creation_idempotency_key_hash_format
    CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_creation_idempotency_request_hash_format
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_creation_idempotency_status_valid
    CHECK (status IN ('in_progress', 'completed', 'failed')),
  CONSTRAINT workspace_creation_idempotency_result_ref_bounded
    CHECK (octet_length(result_ref::text) <= 4096),
  CONSTRAINT workspace_creation_idempotency_completed_result
    CHECK (
      status <> 'completed'
      OR (resource_id IS NOT NULL AND result_ref <> '{}'::jsonb)
    )
);

ALTER TABLE app.workspace_creation_idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_creation_idempotency_records FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_creation_idempotency_actor_scope
  ON app.workspace_creation_idempotency_records
  FOR ALL
  TO {{api_runtime_role}}
  USING (
    actor_user_id::text = NULLIF(current_setting('app.actor_id', true), '')
  )
  WITH CHECK (
    actor_user_id::text = NULLIF(current_setting('app.actor_id', true), '')
  );

REVOKE ALL
  ON app.workspace_creation_idempotency_records
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};

GRANT SELECT, INSERT
  ON app.workspace_creation_idempotency_records
  TO {{api_runtime_role}};

GRANT UPDATE (status, resource_id, result_ref, updated_at)
  ON app.workspace_creation_idempotency_records
  TO {{api_runtime_role}};
