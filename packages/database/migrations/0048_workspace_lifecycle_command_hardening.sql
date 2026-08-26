-- ADR 027 command-role hardening. Every destructive projection is bound to one
-- durable, authorized operation and a currently live lease.

ALTER TABLE app.workspace_lifecycle_operations
  ADD COLUMN append_authorized_at timestamptz,
  ADD CONSTRAINT workspace_lifecycle_operations_authorization_time_valid
    CHECK (append_authorized_at IS NULL OR append_authorized_at>=occurred_at);

SELECT set_config('app.workspace_lifecycle_operation_transition','on',true);
UPDATE app.workspace_lifecycle_operations
SET occurred_at=date_trunc('milliseconds',occurred_at)
WHERE status IN ('pending','running');

CREATE FUNCTION app.canonicalize_workspace_lifecycle_operation_time()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  NEW.occurred_at:=date_trunc('milliseconds',NEW.occurred_at);
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_lifecycle_operations_canonical_time
  BEFORE INSERT ON app.workspace_lifecycle_operations FOR EACH ROW
  EXECUTE FUNCTION app.canonicalize_workspace_lifecycle_operation_time();

CREATE OR REPLACE FUNCTION app.claim_workspace_lifecycle_operations(
  p_lease_owner varchar,p_limit integer,p_lease_interval interval
) RETURNS TABLE(
  operation_id uuid,workspace_id uuid,command_type varchar,actor_user_id uuid,
  reason varchar,request_hash char(64),occurred_at timestamptz,
  lease_token uuid,lease_fence bigint,attempt_count integer
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_now timestamptz;
BEGIN
  IF p_lease_owner IS NULL OR length(btrim(p_lease_owner)) NOT BETWEEN 1 AND 128
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25
    OR p_lease_interval IS NULL OR p_lease_interval<=interval '0 seconds'
    OR p_lease_interval>interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid workspace lifecycle claim' USING ERRCODE='22023';
  END IF;
  v_now:=clock_timestamp();
  PERFORM set_config('app.workspace_lifecycle_operation_transition','on',true);
  RETURN QUERY WITH claimable AS (
    SELECT operation.id FROM app.workspace_lifecycle_operations operation
    WHERE operation.status='pending'
      OR (operation.status='running' AND operation.lease_expires_at<=v_now)
    ORDER BY operation.created_at,operation.id FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), claimed AS (
    UPDATE app.workspace_lifecycle_operations operation SET
      status='running',lease_owner=btrim(p_lease_owner),lease_token=gen_random_uuid(),
      lease_fence=operation.lease_fence+1,lease_acquired_at=v_now,
      lease_expires_at=v_now+p_lease_interval,
      attempt_count=operation.attempt_count+1,updated_at=v_now
    FROM claimable WHERE operation.id=claimable.id RETURNING operation.*
  ) SELECT claimed.id,claimed.workspace_id,claimed.command_type,
    claimed.actor_user_id,claimed.reason,claimed.request_hash,claimed.occurred_at,
    claimed.lease_token,claimed.lease_fence,claimed.attempt_count FROM claimed
  ORDER BY claimed.created_at,claimed.id;
END $$;

CREATE OR REPLACE FUNCTION app.release_workspace_lifecycle_operation(
  p_operation_id uuid,p_lease_token uuid,p_lease_fence bigint
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_updated integer;
BEGIN
  IF p_operation_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_lease_fence<1 THEN
    RAISE EXCEPTION 'invalid workspace lifecycle release' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_lifecycle_operation_transition','on',true);
  UPDATE app.workspace_lifecycle_operations SET status='pending',lease_owner=NULL,
    lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    updated_at=clock_timestamp()
  WHERE id=p_operation_id AND status='running' AND lease_token=p_lease_token
    AND lease_fence=p_lease_fence AND lease_expires_at>clock_timestamp();
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  RETURN v_updated=1;
END $$;

CREATE OR REPLACE FUNCTION app.fail_workspace_lifecycle_operation(
  p_operation_id uuid,p_lease_token uuid,p_lease_fence bigint,p_error_code varchar
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_updated integer;
BEGIN
  IF p_operation_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_lease_fence<1 OR p_error_code IS NULL
    OR p_error_code!~'^[a-z][a-z0-9_.:-]{0,63}$' THEN
    RAISE EXCEPTION 'invalid workspace lifecycle failure' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_lifecycle_operation_transition','on',true);
  UPDATE app.workspace_lifecycle_operations SET status='failed',
    error_code=p_error_code,lease_owner=NULL,lease_token=NULL,
    lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp(),
    completed_at=clock_timestamp()
  WHERE id=p_operation_id AND status='running' AND lease_token=p_lease_token
    AND lease_fence=p_lease_fence AND lease_expires_at>clock_timestamp();
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  RETURN v_updated=1;
END $$;

CREATE OR REPLACE FUNCTION app.complete_workspace_lifecycle_operation(
  p_operation_id uuid,p_lease_token uuid,p_lease_fence bigint,
  p_control_sequence bigint,p_control_record_hash char(64)
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_operation app.workspace_lifecycle_operations%ROWTYPE;
BEGIN
  IF p_operation_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_lease_fence<1 OR p_control_sequence IS NULL OR p_control_sequence<1
    OR p_control_record_hash IS NULL
    OR p_control_record_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid workspace lifecycle completion' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_operation FROM app.workspace_lifecycle_operations
    WHERE id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_operation.status<>'running'
    OR v_operation.lease_token<>p_lease_token
    OR v_operation.lease_fence<>p_lease_fence
    OR v_operation.lease_expires_at<=clock_timestamp() THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_control_ledger_projection record
    WHERE record.workspace_id=v_operation.workspace_id
      AND record.command_id=v_operation.id
      AND record.command_type=v_operation.command_type
      AND record.sequence=p_control_sequence
      AND record.record_hash=p_control_record_hash
      AND record.actor_ref=v_operation.actor_user_id::text
      AND record.reason=v_operation.reason
      AND record.occurred_at=v_operation.occurred_at
  ) THEN
    RAISE EXCEPTION 'workspace lifecycle completion lacks exact projection'
      USING ERRCODE='23503';
  END IF;
  PERFORM set_config('app.workspace_lifecycle_operation_transition','on',true);
  UPDATE app.workspace_lifecycle_operations SET status='completed',
    control_sequence=p_control_sequence,control_record_hash=p_control_record_hash,
    lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    updated_at=clock_timestamp(),completed_at=clock_timestamp()
  WHERE id=p_operation_id;
  RETURN true;
END $$;

CREATE FUNCTION app.lock_workspace_lifecycle_operation(
  p_operation_id uuid,p_lease_token uuid,p_lease_fence bigint
) RETURNS TABLE(
  workspace_id uuid,command_type varchar,actor_ref varchar,reason varchar,
  occurred_at timestamptz,control_sequence bigint,control_hash char(64),
  append_authorized boolean
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_operation app.workspace_lifecycle_operations%ROWTYPE;
DECLARE v_workspace app.workspaces%ROWTYPE;
BEGIN
  SELECT * INTO v_operation FROM app.workspace_lifecycle_operations
    WHERE id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_operation.status<>'running'
    OR v_operation.lease_token<>p_lease_token
    OR v_operation.lease_fence<>p_lease_fence
    OR v_operation.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'workspace lifecycle lease is stale' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_workspace FROM app.workspaces
    WHERE id=v_operation.workspace_id FOR UPDATE;
  RETURN QUERY SELECT v_operation.workspace_id,v_operation.command_type,
    v_operation.actor_user_id::text::varchar,v_operation.reason,v_operation.occurred_at,
    v_workspace.retention_control_sequence,v_workspace.retention_control_hash,
    v_operation.append_authorized_at IS NOT NULL;
END $$;

CREATE FUNCTION app.authorize_workspace_lifecycle_append(
  p_operation_id uuid,p_lease_token uuid,p_lease_fence bigint
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_operation app.workspace_lifecycle_operations%ROWTYPE;
DECLARE v_workspace app.workspaces%ROWTYPE;
BEGIN
  SELECT * INTO v_operation FROM app.workspace_lifecycle_operations
    WHERE id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_operation.status<>'running'
    OR v_operation.lease_token<>p_lease_token
    OR v_operation.lease_fence<>p_lease_fence
    OR v_operation.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'workspace lifecycle lease is stale' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_workspace FROM app.workspaces
    WHERE id=v_operation.workspace_id FOR UPDATE;
  IF v_operation.append_authorized_at IS NOT NULL THEN RETURN true; END IF;
  PERFORM set_config('app.workspace_id',v_operation.workspace_id::text,true);
  IF NOT EXISTS (
    SELECT 1 FROM app.users user_record
    JOIN app.workspace_memberships membership ON membership.user_id=user_record.id
    WHERE user_record.id=v_operation.actor_user_id AND user_record.status='active'
      AND membership.workspace_id=v_operation.workspace_id
      AND membership.status='active' AND membership.role='owner'
  ) THEN
    RAISE EXCEPTION 'workspace lifecycle authorization was lost' USING ERRCODE='42501';
  END IF;
  IF v_operation.command_type='deletion_requested'
    AND v_workspace.status NOT IN ('active','suspended') THEN
    RAISE EXCEPTION 'workspace lifecycle transition is no longer valid'
      USING ERRCODE='55000';
  ELSIF v_operation.command_type='deletion_restored'
    AND (v_workspace.status<>'pending_deletion'
      OR clock_timestamp()>=v_workspace.purge_after) THEN
    RAISE EXCEPTION 'workspace lifecycle transition is no longer valid'
      USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.workspace_lifecycle_operation_transition','on',true);
  UPDATE app.workspace_lifecycle_operations
    SET append_authorized_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=v_operation.id;
  RETURN true;
END $$;

CREATE FUNCTION app.read_workspace_lifecycle_control_command(
  p_operation_id uuid,p_lease_token uuid,p_lease_fence bigint
) RETURNS SETOF app.workspace_control_ledger_projection
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_operation app.workspace_lifecycle_operations%ROWTYPE;
BEGIN
  SELECT * INTO v_operation FROM app.workspace_lifecycle_operations
    WHERE id=p_operation_id;
  IF NOT FOUND OR v_operation.status<>'running'
    OR v_operation.lease_token<>p_lease_token
    OR v_operation.lease_fence<>p_lease_fence
    OR v_operation.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'workspace lifecycle lease is stale' USING ERRCODE='55000';
  END IF;
  RETURN QUERY SELECT record.* FROM app.workspace_control_ledger_projection record
    WHERE record.workspace_id=v_operation.workspace_id
      AND record.command_id=v_operation.id;
END $$;

CREATE FUNCTION app.project_and_complete_workspace_lifecycle_operation(
  p_operation_id uuid,p_lease_token uuid,p_lease_fence bigint,p_sequence bigint,
  p_previous_hash char(64),p_record_hash char(64)
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_operation app.workspace_lifecycle_operations%ROWTYPE;
DECLARE v_projected boolean;
BEGIN
  SELECT * INTO v_operation FROM app.workspace_lifecycle_operations
    WHERE id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_operation.status<>'running'
    OR v_operation.lease_token<>p_lease_token
    OR v_operation.lease_fence<>p_lease_fence
    OR v_operation.lease_expires_at<=clock_timestamp()
    OR v_operation.append_authorized_at IS NULL THEN
    RAISE EXCEPTION 'workspace lifecycle projection is not authorized'
      USING ERRCODE='42501';
  END IF;
  PERFORM set_config('app.workspace_id',v_operation.workspace_id::text,true);
  v_projected:=app.project_workspace_deletion(
    v_operation.workspace_id,p_sequence,v_operation.id,v_operation.command_type,
    v_operation.workspace_id,p_previous_hash,p_record_hash,
    v_operation.actor_user_id::text,NULL,v_operation.reason,
    v_operation.occurred_at,interval '30 days'
  );
  IF v_operation.command_type='deletion_requested' THEN
    UPDATE app.sessions session_record
      SET revoked_at=coalesce(session_record.revoked_at,clock_timestamp())
      WHERE session_record.revoked_at IS NULL AND EXISTS (
        SELECT 1 FROM app.workspace_memberships membership
        WHERE membership.workspace_id=v_operation.workspace_id
          AND membership.user_id=session_record.user_id
          AND membership.status<>'removed'
      );
  END IF;
  IF NOT app.complete_workspace_lifecycle_operation(
    v_operation.id,p_lease_token,p_lease_fence,p_sequence,p_record_hash
  ) THEN
    RAISE EXCEPTION 'workspace lifecycle completion lease is stale'
      USING ERRCODE='55000';
  END IF;
  RETURN v_projected;
END $$;

REVOKE EXECUTE ON FUNCTION
  app.project_workspace_lifecycle_command(uuid,bigint,uuid,varchar,uuid,char,char,varchar,varchar,varchar,timestamptz),
  app.lock_workspace_control_ledger(uuid),
  app.read_workspace_control_command(uuid,uuid),
  app.validate_workspace_deletion_command(uuid,varchar,timestamptz),
  app.complete_workspace_lifecycle_operation(uuid,uuid,bigint,bigint,char)
  FROM {{lifecycle_command_role}};
DROP FUNCTION app.project_workspace_lifecycle_command(
  uuid,bigint,uuid,varchar,uuid,char,char,varchar,varchar,varchar,timestamptz
);
REVOKE ALL ON FUNCTION
  app.canonicalize_workspace_lifecycle_operation_time(),
  app.lock_workspace_lifecycle_operation(uuid,uuid,bigint),
  app.authorize_workspace_lifecycle_append(uuid,uuid,bigint),
  app.read_workspace_lifecycle_control_command(uuid,uuid,bigint),
  app.project_and_complete_workspace_lifecycle_operation(uuid,uuid,bigint,bigint,char,char)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.lock_workspace_lifecycle_operation(uuid,uuid,bigint),
  app.authorize_workspace_lifecycle_append(uuid,uuid,bigint),
  app.read_workspace_lifecycle_control_command(uuid,uuid,bigint),
  app.project_and_complete_workspace_lifecycle_operation(uuid,uuid,bigint,bigint,char,char)
  TO {{lifecycle_command_role}};
