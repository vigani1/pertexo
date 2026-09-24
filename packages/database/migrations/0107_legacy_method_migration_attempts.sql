-- Legacy issuer/subject proof is carried only by a short-lived, browser-bound
-- migration attempt. It cannot authenticate ordinary application requests.
-- The durable marker records that the exact legacy identity, not a matching
-- email, was reauthenticated during an atomic new-method attachment.
ALTER TABLE app.auth_identities
  ADD COLUMN native_method_verified_at timestamptz;
GRANT UPDATE (native_method_verified_at) ON app.auth_identities
  TO {{api_runtime_role}};

CREATE TABLE app.auth_legacy_method_migration_attempts (
  id uuid PRIMARY KEY,
  browser_digest bytea NOT NULL,
  oidc_state_digest bytea NOT NULL UNIQUE,
  target_state_digest bytea UNIQUE,
  target_provider varchar(32) NOT NULL,
  legacy_identity_id uuid REFERENCES app.auth_identities(id) ON DELETE RESTRICT,
  user_id uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  phase varchar(16) NOT NULL DEFAULT 'legacy',
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT auth_legacy_migration_digest_valid CHECK (
    octet_length(browser_digest)=32 AND octet_length(oidc_state_digest)=32
    AND (target_state_digest IS NULL OR octet_length(target_state_digest)=32)
  ),
  CONSTRAINT auth_legacy_migration_provider_valid CHECK (
    target_provider IN ('google','github','microsoft','apple')
  ),
  CONSTRAINT auth_legacy_migration_phase_valid CHECK (
    phase IN ('legacy','target','completed','abandoned')
  ),
  CONSTRAINT auth_legacy_migration_proof_valid CHECK (
    (phase='legacy' AND user_id IS NULL AND legacy_identity_id IS NULL
      AND target_state_digest IS NULL)
    OR (phase<>'legacy' AND user_id IS NOT NULL AND legacy_identity_id IS NOT NULL)
  ),
  CONSTRAINT auth_legacy_migration_completion_valid CHECK (
    (phase='completed')=(completed_at IS NOT NULL)
  ),
  CONSTRAINT auth_legacy_migration_expiry_valid CHECK (expires_at>created_at)
);
CREATE INDEX auth_legacy_method_migration_retention_idx
  ON app.auth_legacy_method_migration_attempts(expires_at,id);
CREATE INDEX auth_legacy_method_migration_user_idx
  ON app.auth_legacy_method_migration_attempts(user_id,created_at);

REVOKE ALL ON app.auth_legacy_method_migration_attempts
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}},
       {{maintenance_role}}, {{lifecycle_command_role}}, {{operator_role}};
GRANT SELECT, INSERT, UPDATE ON app.auth_legacy_method_migration_attempts
  TO {{api_runtime_role}};

CREATE FUNCTION app.prune_auth_legacy_method_migration_attempts(p_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on
AS $$
DECLARE v_deleted integer;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>1000 THEN
    RAISE EXCEPTION 'invalid legacy-migration cleanup limit' USING ERRCODE='22023';
  END IF;
  WITH candidates AS (
    SELECT id FROM app.auth_legacy_method_migration_attempts
     WHERE expires_at<=clock_timestamp()-interval '30 days'
     ORDER BY expires_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.auth_legacy_method_migration_attempts attempt USING candidates
    WHERE attempt.id=candidates.id;
  GET DIAGNOSTICS v_deleted=ROW_COUNT;
  RETURN v_deleted;
END;
$$;
ALTER FUNCTION app.prune_auth_legacy_method_migration_attempts(integer)
  OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.prune_auth_legacy_method_migration_attempts(integer)
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}},
       {{maintenance_role}}, {{lifecycle_command_role}}, {{operator_role}};
GRANT EXECUTE ON FUNCTION app.prune_auth_legacy_method_migration_attempts(integer)
  TO {{maintenance_role}};
