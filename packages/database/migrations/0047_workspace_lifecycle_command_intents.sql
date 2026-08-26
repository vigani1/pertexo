-- ADR 027 durable request/restore intents. This migration is non-destructive and
-- does not change workspace lifecycle state or grant ledger projection authority.

CREATE TABLE app.workspace_lifecycle_operations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  idempotency_key_hash char(64) NOT NULL,
  command_type varchar(32) NOT NULL,
  actor_user_id uuid NOT NULL,
  reason varchar(512) NOT NULL,
  request_hash char(64) NOT NULL,
  occurred_at timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  lease_owner varchar(128),
  lease_token uuid,
  lease_fence bigint NOT NULL DEFAULT 0,
  lease_acquired_at timestamptz,
  lease_expires_at timestamptz,
  control_sequence bigint,
  control_record_hash char(64),
  error_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT workspace_lifecycle_operations_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT workspace_lifecycle_operations_actor_fk
    FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE RESTRICT,
  CONSTRAINT workspace_lifecycle_operations_idempotency_unique
    UNIQUE (workspace_id,idempotency_key_hash),
  CONSTRAINT workspace_lifecycle_operations_command_valid
    CHECK (command_type IN ('deletion_requested','deletion_restored')),
  CONSTRAINT workspace_lifecycle_operations_idempotency_hash_valid
    CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_lifecycle_operations_reason_bounded
    CHECK (length(btrim(reason)) BETWEEN 1 AND 512),
  CONSTRAINT workspace_lifecycle_operations_request_hash_valid
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_lifecycle_operations_status_valid
    CHECK (status IN ('pending','running','completed','failed')),
  CONSTRAINT workspace_lifecycle_operations_attempt_nonnegative
    CHECK (attempt_count >= 0),
  CONSTRAINT workspace_lifecycle_operations_fence_nonnegative
    CHECK (lease_fence >= 0),
  CONSTRAINT workspace_lifecycle_operations_lease_valid CHECK (
    (lease_owner IS NULL AND lease_token IS NULL AND lease_acquired_at IS NULL
      AND lease_expires_at IS NULL)
    OR
    (status='running' AND length(btrim(lease_owner)) BETWEEN 1 AND 128
      AND lease_token IS NOT NULL AND lease_acquired_at IS NOT NULL
      AND lease_expires_at>lease_acquired_at
      AND lease_expires_at<=lease_acquired_at+interval '5 minutes')
  ),
  CONSTRAINT workspace_lifecycle_operations_result_paired
    CHECK ((control_sequence IS NULL)=(control_record_hash IS NULL)),
  CONSTRAINT workspace_lifecycle_operations_result_valid CHECK (
    (status='completed' AND control_sequence>0
      AND control_record_hash ~ '^[0-9a-f]{64}$' AND completed_at IS NOT NULL
      AND error_code IS NULL AND lease_owner IS NULL AND lease_token IS NULL
      AND lease_acquired_at IS NULL AND lease_expires_at IS NULL)
    OR
    (status='failed' AND control_sequence IS NULL AND error_code IS NOT NULL
      AND length(error_code) BETWEEN 1 AND 64 AND completed_at IS NOT NULL
      AND lease_owner IS NULL AND lease_token IS NULL
      AND lease_acquired_at IS NULL AND lease_expires_at IS NULL)
    OR
    (status IN ('pending','running') AND control_sequence IS NULL
      AND error_code IS NULL AND completed_at IS NULL)
  )
);

CREATE INDEX workspace_lifecycle_operations_claim_idx
  ON app.workspace_lifecycle_operations(created_at,id)
  WHERE status IN ('pending','running');
CREATE INDEX workspace_lifecycle_operations_workspace_status_idx
  ON app.workspace_lifecycle_operations(workspace_id,status,created_at,id);

ALTER TABLE app.workspace_lifecycle_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_lifecycle_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_lifecycle_operations_owner_all
  ON app.workspace_lifecycle_operations FOR ALL TO {{owner_role}}
  USING (true) WITH CHECK (true);

CREATE FUNCTION app.reject_workspace_lifecycle_operation_direct_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE'
    OR current_setting('app.workspace_lifecycle_operation_transition',true)
      IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'workspace lifecycle operations change only through command functions'
      USING ERRCODE='55000';
  END IF;
  IF NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id
    OR NEW.idempotency_key_hash<>OLD.idempotency_key_hash
    OR NEW.command_type<>OLD.command_type OR NEW.actor_user_id<>OLD.actor_user_id
    OR NEW.reason<>OLD.reason OR NEW.request_hash<>OLD.request_hash
    OR NEW.occurred_at<>OLD.occurred_at OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'workspace lifecycle operation identity is immutable'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_lifecycle_operations_controlled_mutation
  BEFORE UPDATE OR DELETE ON app.workspace_lifecycle_operations FOR EACH ROW
  EXECUTE FUNCTION app.reject_workspace_lifecycle_operation_direct_mutation();

CREATE FUNCTION app.request_workspace_lifecycle_operation(
  p_id uuid,p_workspace_id uuid,p_idempotency_key_hash char(64),
  p_command_type varchar,p_actor_user_id uuid,p_reason varchar,p_request_hash char(64)
) RETURNS TABLE(
  operation_id uuid,workspace_id uuid,command_type varchar,status varchar,
  occurred_at timestamptz,control_sequence bigint,control_record_hash char(64),
  error_code varchar,created_at timestamptz,updated_at timestamptz,completed_at timestamptz
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_existing app.workspace_lifecycle_operations%ROWTYPE;
  v_workspace app.workspaces%ROWTYPE;
  v_reason varchar(512);
BEGIN
  IF p_workspace_id::text IS DISTINCT FROM
      NULLIF(current_setting('app.workspace_id',true),'')
    OR p_actor_user_id::text IS DISTINCT FROM
      NULLIF(current_setting('app.actor_id',true),'') THEN
    RAISE EXCEPTION 'workspace lifecycle actor is not authorized' USING ERRCODE='42501';
  END IF;
  IF p_id IS NULL OR p_workspace_id IS NULL OR p_actor_user_id IS NULL
    OR p_idempotency_key_hash IS NULL OR p_command_type IS NULL OR p_reason IS NULL
    OR p_request_hash IS NULL
    OR p_command_type NOT IN ('deletion_requested','deletion_restored')
    OR p_idempotency_key_hash !~ '^[0-9a-f]{64}$'
    OR length(btrim(p_reason)) NOT BETWEEN 1 AND 512
    OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid workspace lifecycle operation' USING ERRCODE='22023';
  END IF;
  v_reason:=btrim(p_reason);

  SELECT * INTO v_workspace FROM app.workspaces
    WHERE id=p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace does not exist' USING ERRCODE='23503';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.users user_record
    JOIN app.workspace_memberships membership ON membership.user_id=user_record.id
    WHERE user_record.id=p_actor_user_id AND user_record.status='active'
      AND membership.workspace_id=p_workspace_id AND membership.status='active'
      AND membership.role='owner'
  ) THEN
    RAISE EXCEPTION 'workspace lifecycle actor is not authorized' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_existing FROM app.workspace_lifecycle_operations operation
    WHERE operation.workspace_id=p_workspace_id
      AND operation.idempotency_key_hash=p_idempotency_key_hash;
  IF FOUND THEN
    IF v_existing.command_type<>p_command_type
      OR v_existing.actor_user_id<>p_actor_user_id
      OR v_existing.reason<>v_reason OR v_existing.request_hash<>p_request_hash THEN
      RAISE EXCEPTION 'workspace lifecycle idempotency key conflicts'
        USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT v_existing.id,v_existing.workspace_id,v_existing.command_type,
      v_existing.status,v_existing.occurred_at,v_existing.control_sequence,
      v_existing.control_record_hash,v_existing.error_code,v_existing.created_at,
      v_existing.updated_at,v_existing.completed_at;
    RETURN;
  END IF;
  IF p_command_type='deletion_requested'
    AND v_workspace.status NOT IN ('active','suspended') THEN
    RAISE EXCEPTION 'workspace is not deletable' USING ERRCODE='55000';
  ELSIF p_command_type='deletion_restored'
    AND (v_workspace.status<>'pending_deletion'
      OR clock_timestamp()>=v_workspace.purge_after) THEN
    RAISE EXCEPTION 'workspace is not restorable' USING ERRCODE='55000';
  END IF;

  INSERT INTO app.workspace_lifecycle_operations
    (id,workspace_id,idempotency_key_hash,command_type,actor_user_id,reason,
     request_hash,occurred_at)
  VALUES (p_id,p_workspace_id,p_idempotency_key_hash,p_command_type,p_actor_user_id,
    v_reason,p_request_hash,clock_timestamp());
  RETURN QUERY SELECT operation.id,operation.workspace_id,operation.command_type,
    operation.status,operation.occurred_at,operation.control_sequence,
    operation.control_record_hash,operation.error_code,operation.created_at,
    operation.updated_at,operation.completed_at
  FROM app.workspace_lifecycle_operations operation WHERE operation.id=p_id;
END $$;

CREATE FUNCTION app.project_workspace_lifecycle_command(
  p_workspace_id uuid,p_sequence bigint,p_command_id uuid,p_command_type varchar,
  p_subject_id uuid,p_previous_hash char(64),p_record_hash char(64),
  p_actor_ref varchar,p_legal_authority varchar,p_reason varchar,
  p_occurred_at timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  IF p_command_type NOT IN ('deletion_requested','deletion_restored') THEN
    RAISE EXCEPTION 'lifecycle command role cannot project this command type'
      USING ERRCODE='42501';
  END IF;
  RETURN app.project_workspace_deletion(
    p_workspace_id,p_sequence,p_command_id,p_command_type,p_subject_id,
    p_previous_hash,p_record_hash,p_actor_ref,p_legal_authority,p_reason,
    p_occurred_at,interval '30 days'
  );
END $$;

CREATE FUNCTION app.read_workspace_lifecycle_operation(
  p_workspace_id uuid,p_operation_id uuid,p_actor_user_id uuid
) RETURNS TABLE(
  operation_id uuid,workspace_id uuid,command_type varchar,status varchar,
  occurred_at timestamptz,control_sequence bigint,control_record_hash char(64),
  error_code varchar,created_at timestamptz,updated_at timestamptz,completed_at timestamptz
) LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  IF p_workspace_id::text IS DISTINCT FROM
      NULLIF(current_setting('app.workspace_id',true),'')
    OR p_actor_user_id::text IS DISTINCT FROM
      NULLIF(current_setting('app.actor_id',true),'') THEN
    RAISE EXCEPTION 'workspace lifecycle actor is not authorized' USING ERRCODE='42501';
  END IF;
  IF p_workspace_id IS NULL OR p_operation_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid workspace lifecycle operation lookup' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.users user_record
    JOIN app.workspace_memberships membership ON membership.user_id=user_record.id
    WHERE user_record.id=p_actor_user_id AND user_record.status='active'
      AND membership.workspace_id=p_workspace_id AND membership.status='active'
      AND membership.role='owner'
  ) THEN
    RAISE EXCEPTION 'workspace lifecycle actor is not authorized' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT operation.id,operation.workspace_id,operation.command_type,
    operation.status,operation.occurred_at,operation.control_sequence,
    operation.control_record_hash,operation.error_code,operation.created_at,
    operation.updated_at,operation.completed_at
  FROM app.workspace_lifecycle_operations operation
  WHERE operation.workspace_id=p_workspace_id AND operation.id=p_operation_id;
END $$;

CREATE FUNCTION app.claim_workspace_lifecycle_operations(
  p_lease_owner varchar,p_limit integer,p_lease_interval interval
) RETURNS TABLE(
  operation_id uuid,workspace_id uuid,command_type varchar,actor_user_id uuid,
  reason varchar,request_hash char(64),occurred_at timestamptz,
  lease_token uuid,lease_fence bigint,attempt_count integer
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
BEGIN
  IF p_lease_owner IS NULL OR length(btrim(p_lease_owner)) NOT BETWEEN 1 AND 128
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25
    OR p_lease_interval IS NULL OR p_lease_interval<=interval '0 seconds'
    OR p_lease_interval>interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid workspace lifecycle claim' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_lifecycle_operation_transition','on',true);
  RETURN QUERY WITH claimable AS (
    SELECT operation.id FROM app.workspace_lifecycle_operations operation
    WHERE operation.status='pending'
      OR (operation.status='running' AND operation.lease_expires_at<=clock_timestamp())
    ORDER BY operation.created_at,operation.id FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), claimed AS (
    UPDATE app.workspace_lifecycle_operations operation SET
      status='running',lease_owner=btrim(p_lease_owner),lease_token=gen_random_uuid(),
      lease_fence=operation.lease_fence+1,lease_acquired_at=clock_timestamp(),
      lease_expires_at=clock_timestamp()+p_lease_interval,
      attempt_count=operation.attempt_count+1,updated_at=clock_timestamp()
    FROM claimable WHERE operation.id=claimable.id RETURNING operation.*
  ) SELECT claimed.id,claimed.workspace_id,claimed.command_type,
    claimed.actor_user_id,claimed.reason,claimed.request_hash,claimed.occurred_at,
    claimed.lease_token,claimed.lease_fence,claimed.attempt_count FROM claimed
  ORDER BY claimed.created_at,claimed.id;
END $$;

CREATE FUNCTION app.release_workspace_lifecycle_operation(
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
    AND lease_fence=p_lease_fence;
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  RETURN v_updated=1;
END $$;

CREATE FUNCTION app.complete_workspace_lifecycle_operation(
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
    OR v_operation.lease_fence<>p_lease_fence THEN
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

CREATE FUNCTION app.fail_workspace_lifecycle_operation(
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
    AND lease_fence=p_lease_fence;
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  RETURN v_updated=1;
END $$;

REVOKE ALL ON TABLE app.workspace_lifecycle_operations FROM PUBLIC,
  {{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
  {{maintenance_role}},{{lifecycle_command_role}};
REVOKE ALL ON FUNCTION app.reject_workspace_lifecycle_operation_direct_mutation(),
  app.request_workspace_lifecycle_operation(uuid,uuid,char,varchar,uuid,varchar,char),
  app.read_workspace_lifecycle_operation(uuid,uuid,uuid),
  app.project_workspace_lifecycle_command(uuid,bigint,uuid,varchar,uuid,char,char,varchar,varchar,varchar,timestamptz),
  app.claim_workspace_lifecycle_operations(varchar,integer,interval),
  app.release_workspace_lifecycle_operation(uuid,uuid,bigint),
  app.complete_workspace_lifecycle_operation(uuid,uuid,bigint,bigint,char),
  app.fail_workspace_lifecycle_operation(uuid,uuid,bigint,varchar) FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO {{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION
  app.request_workspace_lifecycle_operation(uuid,uuid,char,varchar,uuid,varchar,char),
  app.read_workspace_lifecycle_operation(uuid,uuid,uuid) TO {{api_runtime_role}};
GRANT EXECUTE ON FUNCTION
  app.claim_workspace_lifecycle_operations(varchar,integer,interval),
  app.release_workspace_lifecycle_operation(uuid,uuid,bigint),
  app.complete_workspace_lifecycle_operation(uuid,uuid,bigint,bigint,char),
  app.fail_workspace_lifecycle_operation(uuid,uuid,bigint,varchar),
  app.lock_workspace_control_ledger(uuid),
  app.read_workspace_control_command(uuid,uuid),
  app.validate_workspace_deletion_command(uuid,varchar,timestamptz),
  app.project_workspace_lifecycle_command(uuid,bigint,uuid,varchar,uuid,char,char,varchar,varchar,varchar,timestamptz)
  TO {{lifecycle_command_role}};
