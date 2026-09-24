-- A linking attempt binds two independently verified methods to one browser
-- session. Provider state and the browser binding are stored only as digests.
CREATE TABLE app.auth_method_link_attempts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  browser_digest bytea NOT NULL,
  source_provider varchar(32) NOT NULL,
  target_provider varchar(32) NOT NULL,
  phase varchar(16) NOT NULL,
  state_digest bytea UNIQUE,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT auth_method_link_browser_digest_valid
    CHECK (octet_length(browser_digest)=32),
  CONSTRAINT auth_method_link_state_digest_valid
    CHECK (state_digest IS NULL OR octet_length(state_digest)=32),
  CONSTRAINT auth_method_link_provider_valid CHECK (
    source_provider IN ('credential','google','github','microsoft','apple')
    AND target_provider IN ('google','github','microsoft','apple')
    AND source_provider<>target_provider
  ),
  CONSTRAINT auth_method_link_phase_valid
    CHECK (phase IN ('source','target','completed','abandoned')),
  CONSTRAINT auth_method_link_expiry_valid CHECK (expires_at>created_at),
  CONSTRAINT auth_method_link_completion_valid CHECK (
    (phase='completed')=(completed_at IS NOT NULL)
  )
);
CREATE INDEX auth_method_link_attempts_user_idx
  ON app.auth_method_link_attempts(user_id,session_id,created_at);
CREATE INDEX auth_method_link_attempts_retention_idx
  ON app.auth_method_link_attempts(expires_at,id);

REVOKE ALL ON app.auth_method_link_attempts
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}},
       {{maintenance_role}}, {{lifecycle_command_role}}, {{operator_role}};
GRANT SELECT, INSERT, UPDATE ON app.auth_method_link_attempts
  TO {{api_runtime_role}};

CREATE FUNCTION app.prune_auth_method_link_attempts(p_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on
AS $$
DECLARE v_deleted integer;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>1000 THEN
    RAISE EXCEPTION 'invalid link-attempt cleanup limit' USING ERRCODE='22023';
  END IF;
  WITH candidates AS (
    SELECT id FROM app.auth_method_link_attempts
     WHERE expires_at<=clock_timestamp()-interval '30 days'
     ORDER BY expires_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.auth_method_link_attempts attempt USING candidates
    WHERE attempt.id=candidates.id;
  GET DIAGNOSTICS v_deleted=ROW_COUNT;
  RETURN v_deleted;
END;
$$;
ALTER FUNCTION app.prune_auth_method_link_attempts(integer)
  OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.prune_auth_method_link_attempts(integer)
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}},
       {{maintenance_role}}, {{lifecycle_command_role}}, {{operator_role}};
GRANT EXECUTE ON FUNCTION app.prune_auth_method_link_attempts(integer)
  TO {{maintenance_role}};
