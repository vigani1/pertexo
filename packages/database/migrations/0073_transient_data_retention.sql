ALTER TABLE app.idempotency_records
  ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '24 hours');

CREATE POLICY idempotency_records_owner_maintenance
  ON app.idempotency_records FOR ALL TO {{owner_role}}
  USING (true) WITH CHECK (true);

CREATE POLICY workspace_creation_idempotency_owner_maintenance
  ON app.workspace_creation_idempotency_records FOR ALL TO {{owner_role}}
  USING (true) WITH CHECK (true);

UPDATE app.idempotency_records
SET expires_at = created_at + interval '24 hours'
WHERE expires_at IS NULL;

ALTER TABLE app.idempotency_records
  ALTER COLUMN expires_at SET NOT NULL;

ALTER TABLE app.workspace_creation_idempotency_records
  ADD COLUMN expires_at timestamptz;

UPDATE app.workspace_creation_idempotency_records
SET expires_at = created_at + interval '24 hours';

ALTER TABLE app.workspace_creation_idempotency_records
  ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '24 hours'),
  ALTER COLUMN expires_at SET NOT NULL,
  ADD CONSTRAINT workspace_creation_idempotency_expiry_valid
    CHECK (expires_at > created_at);

CREATE INDEX workspace_creation_idempotency_expiry_idx
  ON app.workspace_creation_idempotency_records (expires_at, id);

CREATE INDEX sessions_retention_idx
  ON app.sessions (coalesce(revoked_at, expires_at), id);

CREATE FUNCTION app.reap_transient_data(p_limit integer DEFAULT 100)
RETURNS TABLE (
  idempotency_records_deleted integer,
  workspace_creation_records_deleted integer,
  sessions_deleted integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  v_idempotency_records_deleted integer;
  v_workspace_creation_records_deleted integer;
  v_sessions_deleted integer;
BEGIN
  IF p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'transient-data reaper limit must be between 1 and 1000';
  END IF;

  WITH candidates AS (
    SELECT record.id
    FROM app.idempotency_records record
    WHERE record.status = 'completed'
      AND record.expires_at <= clock_timestamp()
      AND NOT EXISTS (
        SELECT 1
        FROM app.workspace_legal_holds hold
        WHERE hold.workspace_id = record.workspace_id
          AND hold.released_sequence IS NULL
      )
    ORDER BY record.expires_at, record.id
    LIMIT p_limit
    FOR UPDATE OF record SKIP LOCKED
  )
  DELETE FROM app.idempotency_records record
  USING candidates
  WHERE record.id = candidates.id;
  GET DIAGNOSTICS v_idempotency_records_deleted = ROW_COUNT;

  WITH candidates AS (
    SELECT record.id
    FROM app.workspace_creation_idempotency_records record
    WHERE record.status IN ('completed', 'failed')
      AND record.expires_at <= clock_timestamp()
      AND NOT EXISTS (
        SELECT 1
        FROM app.workspace_legal_holds hold
        WHERE hold.workspace_id = record.resource_id
          AND hold.released_sequence IS NULL
      )
    ORDER BY record.expires_at, record.id
    LIMIT p_limit
    FOR UPDATE OF record SKIP LOCKED
  )
  DELETE FROM app.workspace_creation_idempotency_records record
  USING candidates
  WHERE record.id = candidates.id;
  GET DIAGNOSTICS v_workspace_creation_records_deleted = ROW_COUNT;

  WITH candidates AS (
    SELECT session.id
    FROM app.sessions session
    WHERE coalesce(session.revoked_at, session.expires_at)
      <= clock_timestamp() - interval '30 days'
    ORDER BY coalesce(session.revoked_at, session.expires_at), session.id
    LIMIT p_limit
    FOR UPDATE OF session SKIP LOCKED
  )
  DELETE FROM app.sessions session
  USING candidates
  WHERE session.id = candidates.id;
  GET DIAGNOSTICS v_sessions_deleted = ROW_COUNT;

  RETURN QUERY SELECT v_idempotency_records_deleted,
    v_workspace_creation_records_deleted, v_sessions_deleted;
END;
$$;

REVOKE ALL ON FUNCTION app.reap_transient_data(integer)
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}},
    {{dispatcher_role}}, {{lifecycle_command_role}}, {{operator_role}};
GRANT EXECUTE ON FUNCTION app.reap_transient_data(integer)
  TO {{maintenance_role}};
