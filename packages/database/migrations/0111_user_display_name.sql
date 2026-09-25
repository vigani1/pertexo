-- Conditional, idempotent self-service display-name changes (ADR 043).
-- The receipts are identity-scoped platform rows, not tenant rows: a user
-- renames themselves outside any workspace, so there is no tenant policy.

ALTER TABLE app.users
  ADD COLUMN profile_revision integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT users_profile_revision_positive CHECK (profile_revision > 0);

CREATE TABLE app.user_profile_command_receipts (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL,
  key_hash char(64) NOT NULL,
  request_hash char(64) NOT NULL,
  status varchar(32) NOT NULL,
  result_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT user_profile_command_receipts_actor_fk
    FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE CASCADE,
  CONSTRAINT user_profile_command_receipts_status_valid
    CHECK (status IN ('in_progress','completed')),
  CONSTRAINT user_profile_command_receipts_hashes_valid
    CHECK (key_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_profile_command_receipts_result_valid
    CHECK ((status='in_progress' AND result_ref IS NULL)
      OR (status='completed' AND result_ref IS NOT NULL))
);

CREATE UNIQUE INDEX user_profile_command_receipts_key_unique
  ON app.user_profile_command_receipts(actor_user_id,key_hash);

REVOKE ALL ON app.user_profile_command_receipts
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
GRANT SELECT, INSERT ON app.user_profile_command_receipts TO {{api_runtime_role}};
GRANT UPDATE (status,result_ref,updated_at)
  ON app.user_profile_command_receipts TO {{api_runtime_role}};
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.user_profile_command_receipts
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
GRANT UPDATE (profile_revision) ON app.users TO {{api_runtime_role}};

-- The identity-scoped audit fact names the change, never the name itself.
ALTER TABLE app.identity_security_audit_facts
  DROP CONSTRAINT identity_security_audit_event_valid,
  ADD CONSTRAINT identity_security_audit_event_valid CHECK (
    event_type IN ('email.initial_verified','email.old_confirmed',
                   'email.change_verified','method.linked','method.unlinked',
                   'legacy.method_migrated','password.changed',
                   'password.configured','password.reset',
                   'profile.display_name_changed')
  );

CREATE FUNCTION app.record_identity_profile_audit_fact(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on
AS $$
BEGIN
  IF p_user_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM app.users WHERE id=p_user_id) THEN
    RAISE EXCEPTION 'invalid identity audit fact' USING ERRCODE='22023';
  END IF;
  INSERT INTO app.identity_security_audit_facts(id,user_id,event_type)
  VALUES (gen_random_uuid(),p_user_id,'profile.display_name_changed');
END;
$$;

ALTER FUNCTION app.record_identity_profile_audit_fact(uuid)
  OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.record_identity_profile_audit_fact(uuid)
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}},
       {{maintenance_role}}, {{lifecycle_command_role}}, {{operator_role}};
GRANT EXECUTE ON FUNCTION app.record_identity_profile_audit_fact(uuid)
  TO {{api_runtime_role}};
