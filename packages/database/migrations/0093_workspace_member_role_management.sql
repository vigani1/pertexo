-- Existing-member role management (ADR 037).

ALTER TABLE app.workspace_memberships
  ADD COLUMN role_revision integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT workspace_memberships_role_revision_positive
    CHECK (role_revision > 0);

CREATE TABLE app.workspace_member_role_command_receipts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  target_user_id uuid NOT NULL,
  key_hash char(64) NOT NULL,
  request_hash char(64) NOT NULL,
  status varchar(32) NOT NULL,
  result_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_member_role_command_receipts_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE,
  CONSTRAINT workspace_member_role_command_receipts_actor_fk
    FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE RESTRICT,
  CONSTRAINT workspace_member_role_command_receipts_target_fk
    FOREIGN KEY (target_user_id) REFERENCES app.users(id) ON DELETE RESTRICT,
  CONSTRAINT workspace_member_role_command_receipts_status_valid
    CHECK (status IN ('in_progress','completed')),
  CONSTRAINT workspace_member_role_command_receipts_hashes_valid
    CHECK (key_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_member_role_command_receipts_result_valid
    CHECK ((status='in_progress' AND result_ref IS NULL)
      OR (status='completed' AND result_ref IS NOT NULL))
);

CREATE UNIQUE INDEX workspace_member_role_command_receipts_key_unique
  ON app.workspace_member_role_command_receipts(actor_user_id,workspace_id,key_hash);
CREATE INDEX workspace_member_role_command_receipts_workspace_idx
  ON app.workspace_member_role_command_receipts(workspace_id,created_at,id);

ALTER TABLE app.workspace_member_role_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_member_role_command_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_member_role_command_receipts_workspace_scope
  ON app.workspace_member_role_command_receipts
  FOR ALL TO {{api_runtime_role}}
  USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));

REVOKE ALL ON app.workspace_member_role_command_receipts
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
GRANT SELECT, INSERT ON app.workspace_member_role_command_receipts TO {{api_runtime_role}};
GRANT UPDATE (status,result_ref,updated_at)
  ON app.workspace_member_role_command_receipts TO {{api_runtime_role}};
GRANT UPDATE (role,role_revision,updated_at)
  ON app.workspace_memberships TO {{api_runtime_role}};
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.workspace_member_role_command_receipts
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};

-- Forward-patch the bounded tenant purge surface without rewriting a published migration.
DO $$
DECLARE v_definition text;
BEGIN
  SELECT pg_get_functiondef('app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)'::regprocedure)
    INTO v_definition;
  v_definition:=replace(
    v_definition,
    '''workspace_memberships''',
    '''workspace_member_role_command_receipts'', ''workspace_memberships'''
  );
  IF position('workspace_member_role_command_receipts' in v_definition)=0 THEN
    RAISE EXCEPTION 'workspace tenant purge function shape is incompatible';
  END IF;
  EXECUTE v_definition;
END $$;
