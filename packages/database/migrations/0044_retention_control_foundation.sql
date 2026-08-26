-- ADR 013 control-plane foundation. This migration intentionally contains no
-- tenant-data deletion or payload-clearing operation.
-- Pertexo has not launched to production. The non-concurrent index below is a
-- deliberate prelaunch migration and 0044 must land before production data.

ALTER TABLE app.workspaces
  ADD COLUMN retention_control_sequence bigint NOT NULL DEFAULT 0,
  ADD COLUMN retention_control_hash char(64) NOT NULL DEFAULT repeat('0', 64),
  ADD CONSTRAINT workspaces_retention_control_sequence_nonnegative
    CHECK (retention_control_sequence >= 0),
  ADD CONSTRAINT workspaces_retention_control_hash_format
    CHECK (retention_control_hash ~ '^[0-9a-f]{64}$');

CREATE FUNCTION app.enforce_workspace_retention_control_initial_state()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.retention_control_sequence IS DISTINCT FROM 0
    OR NEW.retention_control_hash IS DISTINCT FROM repeat('0',64) THEN
    RAISE EXCEPTION 'new workspace retention control high water must be empty'
      USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspaces_retention_control_initial_state
  BEFORE INSERT ON app.workspaces FOR EACH ROW
  EXECUTE FUNCTION app.enforce_workspace_retention_control_initial_state();

CREATE INDEX workflow_runs_due_input_ref_retention_idx
  ON app.workflow_runs (workspace_id, input_ref_expires_at, id)
  WHERE input_ref IS NOT NULL;

CREATE TABLE app.workspace_control_ledger_projection (
  workspace_id uuid NOT NULL,
  sequence bigint NOT NULL,
  command_id uuid NOT NULL,
  command_type varchar(32) NOT NULL,
  subject_id uuid NOT NULL,
  previous_hash char(64) NOT NULL,
  record_hash char(64) NOT NULL,
  actor_ref varchar(128) NOT NULL,
  legal_authority varchar(256),
  reason varchar(512) NOT NULL,
  occurred_at timestamptz NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_control_ledger_projection_pk PRIMARY KEY (workspace_id, sequence),
  CONSTRAINT workspace_control_ledger_projection_command_unique UNIQUE (workspace_id, command_id),
  CONSTRAINT workspace_control_ledger_projection_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES app.workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT workspace_control_ledger_projection_sequence_positive CHECK (sequence > 0),
  CONSTRAINT workspace_control_ledger_projection_command_type_valid
    CHECK (command_type IN (
      'legal_hold_placed', 'legal_hold_released', 'deletion_requested',
      'deletion_restored', 'purge_started', 'deletion_completed'
    )),
  CONSTRAINT workspace_control_ledger_projection_hashes_valid CHECK (
    previous_hash ~ '^[0-9a-f]{64}$' AND record_hash ~ '^[0-9a-f]{64}$'
    AND previous_hash <> record_hash
  ),
  CONSTRAINT workspace_control_ledger_projection_actor_bounded
    CHECK (length(btrim(actor_ref)) BETWEEN 1 AND 128),
  CONSTRAINT workspace_control_ledger_projection_authority_valid CHECK (
    (command_type IN ('legal_hold_placed','legal_hold_released')
      AND legal_authority IS NOT NULL
      AND length(btrim(legal_authority)) BETWEEN 1 AND 256)
    OR (command_type NOT IN ('legal_hold_placed','legal_hold_released')
      AND (legal_authority IS NULL OR length(btrim(legal_authority)) BETWEEN 1 AND 256))
  ),
  CONSTRAINT workspace_control_ledger_projection_reason_bounded
    CHECK (length(btrim(reason)) BETWEEN 1 AND 512),
  CONSTRAINT workspace_control_ledger_projection_subject_record_unique
    UNIQUE (workspace_id, sequence, subject_id, command_type, record_hash),
  CONSTRAINT workspace_control_ledger_projection_command_record_unique
    UNIQUE (workspace_id, command_id, subject_id, command_type, sequence),
  CONSTRAINT workspace_control_ledger_projection_audit_record_unique
    UNIQUE (workspace_id, command_id, subject_id, command_type, sequence,
      record_hash, actor_ref, occurred_at)
);

CREATE TABLE app.workspace_legal_holds (
  workspace_id uuid NOT NULL,
  hold_id uuid NOT NULL,
  placed_sequence bigint NOT NULL,
  placed_record_hash char(64) NOT NULL,
  legal_authority varchar(256) NOT NULL,
  placement_reason varchar(512) NOT NULL,
  placed_by varchar(128) NOT NULL,
  placed_at timestamptz NOT NULL,
  released_sequence bigint,
  released_record_hash char(64),
  release_authority varchar(256),
  release_reason varchar(512),
  released_by varchar(128),
  released_at timestamptz,
  CONSTRAINT workspace_legal_holds_pk PRIMARY KEY (workspace_id, hold_id),
  CONSTRAINT workspace_legal_holds_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES app.workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT workspace_legal_holds_placement_record_fk
    FOREIGN KEY (workspace_id, placed_sequence)
    REFERENCES app.workspace_control_ledger_projection (workspace_id, sequence) ON DELETE RESTRICT,
  CONSTRAINT workspace_legal_holds_release_record_fk
    FOREIGN KEY (workspace_id, released_sequence)
    REFERENCES app.workspace_control_ledger_projection (workspace_id, sequence) ON DELETE RESTRICT,
  CONSTRAINT workspace_legal_holds_placement_valid CHECK (
    placed_sequence > 0 AND placed_record_hash ~ '^[0-9a-f]{64}$'
    AND length(btrim(legal_authority)) BETWEEN 1 AND 256
    AND length(btrim(placement_reason)) BETWEEN 1 AND 512
    AND length(btrim(placed_by)) BETWEEN 1 AND 128
  ),
  CONSTRAINT workspace_legal_holds_release_valid CHECK (
    (released_sequence IS NULL AND released_record_hash IS NULL
      AND release_authority IS NULL AND release_reason IS NULL
      AND released_by IS NULL AND released_at IS NULL)
    OR
    (released_sequence IS NOT NULL AND released_record_hash IS NOT NULL
      AND release_authority IS NOT NULL AND release_reason IS NOT NULL
      AND released_by IS NOT NULL AND released_at IS NOT NULL
      AND released_sequence > placed_sequence
      AND released_record_hash ~ '^[0-9a-f]{64}$'
      AND length(btrim(release_authority)) BETWEEN 1 AND 256
      AND length(btrim(release_reason)) BETWEEN 1 AND 512
      AND length(btrim(released_by)) BETWEEN 1 AND 128
      AND released_at >= placed_at)
  )
);
CREATE INDEX workspace_legal_holds_active_idx
  ON app.workspace_legal_holds (workspace_id, hold_id)
  WHERE released_sequence IS NULL;

CREATE TABLE app.retention_control_audit_facts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  command_id uuid NOT NULL,
  fact_type varchar(32) NOT NULL,
  subject_id uuid NOT NULL,
  control_sequence bigint NOT NULL,
  control_record_hash char(64) NOT NULL,
  actor_ref varchar(128) NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT retention_control_audit_facts_record_fk
    FOREIGN KEY (workspace_id, command_id, subject_id, fact_type, control_sequence,
      control_record_hash, actor_ref, occurred_at)
    REFERENCES app.workspace_control_ledger_projection
      (workspace_id, command_id, subject_id, command_type, sequence,
       record_hash, actor_ref, occurred_at) ON DELETE RESTRICT,
  CONSTRAINT retention_control_audit_facts_command_unique UNIQUE (workspace_id, command_id),
  CONSTRAINT retention_control_audit_facts_type_valid
    CHECK (fact_type IN ('legal_hold_placed', 'legal_hold_released')),
  CONSTRAINT retention_control_audit_facts_hash_valid
    CHECK (control_record_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT retention_control_audit_facts_actor_bounded
    CHECK (length(btrim(actor_ref)) BETWEEN 1 AND 128)
);
CREATE INDEX retention_control_audit_facts_workspace_time_idx
  ON app.retention_control_audit_facts (workspace_id, occurred_at, id);

CREATE FUNCTION app.enforce_workspace_legal_hold_ledger_links()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.workspace_control_ledger_projection record
    WHERE record.workspace_id=NEW.workspace_id AND record.sequence=NEW.placed_sequence
      AND record.subject_id=NEW.hold_id AND record.command_type='legal_hold_placed'
      AND record.record_hash=NEW.placed_record_hash
      AND record.legal_authority=NEW.legal_authority
      AND record.reason=NEW.placement_reason AND record.actor_ref=NEW.placed_by
      AND record.occurred_at=NEW.placed_at
  ) THEN
    RAISE EXCEPTION 'legal hold placement does not match its control record' USING ERRCODE='23503';
  END IF;
  IF NEW.released_sequence IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.workspace_control_ledger_projection record
    WHERE record.workspace_id=NEW.workspace_id AND record.sequence=NEW.released_sequence
      AND record.subject_id=NEW.hold_id AND record.command_type='legal_hold_released'
      AND record.record_hash=NEW.released_record_hash
      AND record.legal_authority=NEW.release_authority
      AND record.reason=NEW.release_reason AND record.actor_ref=NEW.released_by
      AND record.occurred_at=NEW.released_at
  ) THEN
    RAISE EXCEPTION 'legal hold release does not match its control record' USING ERRCODE='23503';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER workspace_legal_holds_ledger_links
  AFTER INSERT OR UPDATE ON app.workspace_legal_holds
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW
  EXECUTE FUNCTION app.enforce_workspace_legal_hold_ledger_links();

CREATE TABLE app.retention_batches (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  retention_kind varchar(32) NOT NULL,
  cutoff_at timestamptz NOT NULL,
  dry_run boolean NOT NULL DEFAULT true,
  requested_by varchar(128) NOT NULL,
  reason varchar(512) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'ready',
  cursor_expires_at timestamptz,
  cursor_id uuid,
  examined_count bigint NOT NULL DEFAULT 0,
  eligible_count bigint NOT NULL DEFAULT 0,
  lease_owner varchar(128),
  lease_token uuid,
  lease_fence bigint NOT NULL DEFAULT 0,
  lease_acquired_at timestamptz,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT retention_batches_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES app.workspaces (id) ON DELETE RESTRICT,
  CONSTRAINT retention_batches_idempotency_unique UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT retention_batches_kind_valid CHECK (retention_kind = 'workflow_run_input'),
  CONSTRAINT retention_batches_dry_run_only CHECK (dry_run),
  CONSTRAINT retention_batches_idempotency_bounded
    CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 128),
  CONSTRAINT retention_batches_requested_by_bounded
    CHECK (length(btrim(requested_by)) BETWEEN 1 AND 128),
  CONSTRAINT retention_batches_reason_bounded
    CHECK (length(btrim(reason)) BETWEEN 1 AND 512),
  CONSTRAINT retention_batches_status_valid CHECK (status IN ('ready', 'running', 'completed')),
  CONSTRAINT retention_batches_cursor_paired CHECK ((cursor_expires_at IS NULL) = (cursor_id IS NULL)),
  CONSTRAINT retention_batches_counts_nonnegative CHECK (examined_count >= 0 AND eligible_count >= 0),
  CONSTRAINT retention_batches_eligible_bounded CHECK (eligible_count <= examined_count),
  CONSTRAINT retention_batches_fence_nonnegative CHECK (lease_fence >= 0),
  CONSTRAINT retention_batches_lease_valid CHECK (
    (lease_owner IS NULL AND lease_token IS NULL AND lease_acquired_at IS NULL AND lease_expires_at IS NULL)
    OR
    (status = 'running' AND length(btrim(lease_owner)) BETWEEN 1 AND 128 AND lease_token IS NOT NULL
      AND lease_acquired_at IS NOT NULL AND lease_expires_at > lease_acquired_at
      AND lease_expires_at <= lease_acquired_at + interval '5 minutes')
  ),
  CONSTRAINT retention_batches_completion_valid CHECK (
    (status = 'completed' AND completed_at IS NOT NULL AND lease_owner IS NULL
      AND lease_token IS NULL AND lease_acquired_at IS NULL AND lease_expires_at IS NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  )
);
CREATE INDEX retention_batches_claim_idx
  ON app.retention_batches (created_at, id)
  WHERE status IN ('ready', 'running');

ALTER TABLE app.workspace_control_ledger_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_control_ledger_projection FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_legal_holds FORCE ROW LEVEL SECURITY;
ALTER TABLE app.retention_control_audit_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.retention_control_audit_facts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.retention_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.retention_batches FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_control_ledger_projection_owner_all
  ON app.workspace_control_ledger_projection FOR ALL TO {{owner_role}}
  USING (true) WITH CHECK (true);
CREATE POLICY workspace_legal_holds_owner_all
  ON app.workspace_legal_holds FOR ALL TO {{owner_role}}
  USING (true) WITH CHECK (true);
CREATE POLICY retention_control_audit_facts_owner_all
  ON app.retention_control_audit_facts FOR ALL TO {{owner_role}}
  USING (true) WITH CHECK (true);
CREATE POLICY retention_batches_owner_all
  ON app.retention_batches FOR ALL TO {{owner_role}}
  USING (true) WITH CHECK (true);

CREATE FUNCTION app.reject_retention_control_fact_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'retention control facts are immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER workspace_control_ledger_projection_immutable
  BEFORE UPDATE OR DELETE ON app.workspace_control_ledger_projection
  FOR EACH ROW EXECUTE FUNCTION app.reject_retention_control_fact_mutation();
CREATE TRIGGER retention_control_audit_facts_immutable
  BEFORE UPDATE OR DELETE ON app.retention_control_audit_facts
  FOR EACH ROW EXECUTE FUNCTION app.reject_retention_control_fact_mutation();

CREATE FUNCTION app.reject_workspace_legal_hold_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR current_setting('app.retention_control_transition', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'workspace legal holds change only through control projection' USING ERRCODE='55000';
  END IF;
  IF NEW.workspace_id <> OLD.workspace_id OR NEW.hold_id <> OLD.hold_id
    OR NEW.placed_sequence <> OLD.placed_sequence OR NEW.placed_record_hash <> OLD.placed_record_hash
    OR NEW.legal_authority <> OLD.legal_authority OR NEW.placement_reason <> OLD.placement_reason
    OR NEW.placed_by <> OLD.placed_by OR NEW.placed_at <> OLD.placed_at
    OR OLD.released_sequence IS NOT NULL THEN
    RAISE EXCEPTION 'workspace legal hold placement is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_legal_holds_controlled_mutation
  BEFORE UPDATE OR DELETE ON app.workspace_legal_holds
  FOR EACH ROW EXECUTE FUNCTION app.reject_workspace_legal_hold_mutation();

CREATE FUNCTION app.reject_retention_batch_direct_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR current_setting('app.retention_batch_transition', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'retention batches change only through maintenance functions' USING ERRCODE='55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id
    OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.retention_kind <> OLD.retention_kind
    OR NEW.cutoff_at <> OLD.cutoff_at OR NEW.dry_run <> OLD.dry_run
    OR NEW.requested_by <> OLD.requested_by OR NEW.reason <> OLD.reason
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'retention batch identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retention_batches_controlled_mutation
  BEFORE UPDATE OR DELETE ON app.retention_batches
  FOR EACH ROW EXECUTE FUNCTION app.reject_retention_batch_direct_mutation();

CREATE FUNCTION app.project_workspace_legal_hold(
  p_workspace_id uuid, p_sequence bigint, p_command_id uuid, p_command_type varchar,
  p_hold_id uuid, p_previous_hash char(64), p_record_hash char(64),
  p_actor_ref varchar, p_legal_authority varchar, p_reason varchar, p_occurred_at timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_workspace app.workspaces%ROWTYPE;
  v_existing app.workspace_control_ledger_projection%ROWTYPE;
  v_hold app.workspace_legal_holds%ROWTYPE;
  v_actor_ref varchar(128);
  v_legal_authority varchar(256);
  v_reason varchar(512);
BEGIN
  IF p_workspace_id IS NULL OR p_sequence IS NULL OR p_sequence < 1
    OR p_command_id IS NULL OR p_hold_id IS NULL
    OR p_command_type IS NULL OR p_previous_hash IS NULL OR p_record_hash IS NULL
    OR p_actor_ref IS NULL OR p_legal_authority IS NULL OR p_reason IS NULL
    OR p_command_type NOT IN ('legal_hold_placed','legal_hold_released')
    OR p_previous_hash !~ '^[0-9a-f]{64}$' OR p_record_hash !~ '^[0-9a-f]{64}$'
    OR p_previous_hash = p_record_hash OR length(btrim(p_actor_ref)) NOT BETWEEN 1 AND 128
    OR length(btrim(p_legal_authority)) NOT BETWEEN 1 AND 256
    OR length(btrim(p_reason)) NOT BETWEEN 1 AND 512
    OR p_occurred_at IS NULL THEN
    RAISE EXCEPTION 'invalid retention control record' USING ERRCODE='22023';
  END IF;
  v_actor_ref := btrim(p_actor_ref);
  v_legal_authority := btrim(p_legal_authority);
  v_reason := btrim(p_reason);

  SELECT * INTO STRICT v_workspace FROM app.workspaces WHERE id=p_workspace_id FOR UPDATE;
  SELECT * INTO v_existing FROM app.workspace_control_ledger_projection
    WHERE workspace_id=p_workspace_id AND command_id=p_command_id;
  IF FOUND THEN
    IF v_existing.sequence=p_sequence AND v_existing.command_type=p_command_type
      AND v_existing.subject_id=p_hold_id AND v_existing.previous_hash=p_previous_hash
      AND v_existing.record_hash=p_record_hash AND v_existing.actor_ref=v_actor_ref
      AND v_existing.legal_authority=v_legal_authority AND v_existing.reason=v_reason
      AND v_existing.occurred_at=p_occurred_at THEN
      RETURN false;
    END IF;
    RAISE EXCEPTION 'retention control command replay conflicts with projection' USING ERRCODE='23505';
  END IF;
  IF p_sequence <> v_workspace.retention_control_sequence + 1 THEN
    RAISE EXCEPTION 'retention control sequence mismatch' USING ERRCODE='40001';
  END IF;
  IF p_previous_hash <> v_workspace.retention_control_hash THEN
    RAISE EXCEPTION 'retention control previous hash mismatch' USING ERRCODE='40001';
  END IF;

  SELECT * INTO v_hold FROM app.workspace_legal_holds
    WHERE workspace_id=p_workspace_id AND hold_id=p_hold_id;
  IF p_command_type='legal_hold_placed' AND FOUND THEN
    RAISE EXCEPTION 'legal hold already exists' USING ERRCODE='23505';
  ELSIF p_command_type='legal_hold_released' AND (NOT FOUND OR v_hold.released_sequence IS NOT NULL) THEN
    RAISE EXCEPTION 'legal hold is absent or already released' USING ERRCODE='55000';
  END IF;

  INSERT INTO app.workspace_control_ledger_projection
    (workspace_id,sequence,command_id,command_type,subject_id,previous_hash,record_hash,
     actor_ref,legal_authority,reason,occurred_at)
  VALUES (p_workspace_id,p_sequence,p_command_id,p_command_type,p_hold_id,p_previous_hash,p_record_hash,
    v_actor_ref,v_legal_authority,v_reason,p_occurred_at);

  IF p_command_type='legal_hold_placed' THEN
    INSERT INTO app.workspace_legal_holds
      (workspace_id,hold_id,placed_sequence,placed_record_hash,legal_authority,
       placement_reason,placed_by,placed_at)
    VALUES (p_workspace_id,p_hold_id,p_sequence,p_record_hash,v_legal_authority,
      v_reason,v_actor_ref,p_occurred_at);
  ELSE
    PERFORM set_config('app.retention_control_transition','on',true);
    UPDATE app.workspace_legal_holds SET released_sequence=p_sequence,
      released_record_hash=p_record_hash,release_authority=v_legal_authority,
      release_reason=v_reason,released_by=v_actor_ref,released_at=p_occurred_at
    WHERE workspace_id=p_workspace_id AND hold_id=p_hold_id;
  END IF;
  INSERT INTO app.retention_control_audit_facts
    (id,workspace_id,command_id,fact_type,subject_id,control_sequence,
     control_record_hash,actor_ref,occurred_at)
  VALUES (gen_random_uuid(),p_workspace_id,p_command_id,p_command_type,p_hold_id,
    p_sequence,p_record_hash,v_actor_ref,p_occurred_at);
  UPDATE app.workspaces SET retention_control_sequence=p_sequence,
    retention_control_hash=p_record_hash,updated_at=clock_timestamp()
  WHERE id=p_workspace_id;
  RETURN true;
END $$;

CREATE FUNCTION app.start_retention_batch(
  p_id uuid, p_workspace_id uuid, p_idempotency_key varchar,
  p_retention_kind varchar, p_cutoff_at timestamptz, p_dry_run boolean,
  p_requested_by varchar, p_reason varchar
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_existing app.retention_batches%ROWTYPE;
  v_idempotency_key varchar(128);
  v_requested_by varchar(128);
  v_reason varchar(512);
  v_prior_workspace text;
BEGIN
  IF p_id IS NULL OR p_workspace_id IS NULL OR p_idempotency_key IS NULL
    OR p_retention_kind IS NULL OR p_cutoff_at IS NULL OR p_dry_run IS DISTINCT FROM true
    OR p_requested_by IS NULL OR p_reason IS NULL
    OR length(btrim(p_idempotency_key)) NOT BETWEEN 1 AND 128
    OR length(btrim(p_requested_by)) NOT BETWEEN 1 AND 128
    OR length(btrim(p_reason)) NOT BETWEEN 1 AND 512
    OR p_retention_kind <> 'workflow_run_input' THEN
    RAISE EXCEPTION 'invalid retention batch' USING ERRCODE='22023';
  END IF;
  v_idempotency_key := btrim(p_idempotency_key);
  v_requested_by := btrim(p_requested_by);
  v_reason := btrim(p_reason);
  PERFORM 1 FROM app.workspaces WHERE id=p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace does not exist' USING ERRCODE='23503'; END IF;
  SELECT * INTO v_existing FROM app.retention_batches
    WHERE workspace_id=p_workspace_id AND idempotency_key=v_idempotency_key;
  IF FOUND THEN
    IF v_existing.id=p_id AND v_existing.retention_kind=p_retention_kind
      AND v_existing.cutoff_at=p_cutoff_at AND v_existing.dry_run
      AND v_existing.requested_by=v_requested_by AND v_existing.reason=v_reason
      THEN RETURN v_existing.id; END IF;
    RAISE EXCEPTION 'retention batch replay conflicts with existing request' USING ERRCODE='23505';
  END IF;
  INSERT INTO app.retention_batches
    (id,workspace_id,idempotency_key,retention_kind,cutoff_at,dry_run,requested_by,reason)
  VALUES (p_id,p_workspace_id,v_idempotency_key,p_retention_kind,p_cutoff_at,true,v_requested_by,v_reason);
  v_prior_workspace := current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  INSERT INTO app.audit_events
    (id,workspace_id,action,target_type,target_id,metadata)
  VALUES (gen_random_uuid(),p_workspace_id,'retention.batch_started','retention-batch',p_id,
    jsonb_build_object('requestedBy',v_requested_by,'reason',v_reason,'retentionKind',p_retention_kind,
      'cutoffAt',p_cutoff_at,'dryRun',true));
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN p_id;
EXCEPTION WHEN OTHERS THEN
  IF v_prior_workspace IS NOT NULL THEN
    PERFORM set_config('app.workspace_id',v_prior_workspace,true);
  END IF;
  RAISE;
END $$;

CREATE FUNCTION app.claim_retention_batches(
  p_lease_owner varchar, p_limit integer, p_lease_seconds integer
) RETURNS TABLE(batch_id uuid,workspace_id uuid,retention_kind varchar,cutoff_at timestamptz,
  dry_run boolean,requested_by varchar,reason varchar,cursor_expires_at timestamptz,cursor_id uuid,
  lease_token uuid,lease_fence bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_now timestamptz := clock_timestamp();
BEGIN
  IF p_lease_owner IS NULL OR length(btrim(p_lease_owner)) NOT BETWEEN 1 AND 128
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds IS NULL
    OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid retention batch claim bounds' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.retention_batch_transition','on',true);
  RETURN QUERY WITH candidates AS (
    SELECT batch.id FROM app.retention_batches batch
    WHERE batch.status='ready' OR (batch.status='running' AND batch.lease_expires_at<=v_now)
    ORDER BY batch.created_at,batch.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE app.retention_batches batch SET status='running',lease_owner=btrim(p_lease_owner),
      lease_token=gen_random_uuid(),lease_fence=batch.lease_fence+1,lease_acquired_at=v_now,
      lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),updated_at=v_now
    FROM candidates WHERE batch.id=candidates.id RETURNING batch.*
  ) SELECT claimed.id,claimed.workspace_id,claimed.retention_kind,claimed.cutoff_at,
      claimed.dry_run,claimed.requested_by,claimed.reason,claimed.cursor_expires_at,
      claimed.cursor_id,claimed.lease_token,claimed.lease_fence
    FROM claimed ORDER BY claimed.created_at,claimed.id;
END $$;

CREATE FUNCTION app.checkpoint_retention_batch(
  p_batch_id uuid, p_lease_token uuid, p_lease_fence bigint,
  p_cursor_expires_at timestamptz, p_cursor_id uuid,
  p_examined_delta integer, p_eligible_delta integer, p_complete boolean
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_batch app.retention_batches%ROWTYPE;
BEGIN
  IF p_batch_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_examined_delta IS NULL OR p_eligible_delta IS NULL
    OR p_examined_delta NOT BETWEEN 0 AND 1000 OR p_eligible_delta NOT BETWEEN 0 AND p_examined_delta
    OR (p_cursor_expires_at IS NULL) <> (p_cursor_id IS NULL) OR p_complete IS NULL THEN
    RAISE EXCEPTION 'invalid retention checkpoint' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_batch FROM app.retention_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.status<>'running' OR v_batch.lease_token<>p_lease_token
    OR v_batch.lease_fence<>p_lease_fence OR v_batch.lease_expires_at<=clock_timestamp() THEN RETURN false; END IF;
  IF p_cursor_expires_at IS NOT NULL AND v_batch.cursor_expires_at IS NOT NULL
    AND (p_cursor_expires_at,p_cursor_id) <= (v_batch.cursor_expires_at,v_batch.cursor_id) THEN
    RAISE EXCEPTION 'retention cursor must advance monotonically' USING ERRCODE='22023';
  END IF;
  IF p_cursor_expires_at IS NOT NULL AND p_cursor_expires_at > v_batch.cutoff_at THEN
    RAISE EXCEPTION 'retention cursor cannot exceed its cutoff' USING ERRCODE='22023';
  END IF;
  IF NOT p_complete AND (p_examined_delta=0 OR p_cursor_expires_at IS NULL) THEN
    RAISE EXCEPTION 'nonterminal retention checkpoint must report bounded cursor progress' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.retention_batch_transition','on',true);
  UPDATE app.retention_batches SET cursor_expires_at=coalesce(p_cursor_expires_at,cursor_expires_at),
    cursor_id=coalesce(p_cursor_id,cursor_id),examined_count=examined_count+p_examined_delta,
    eligible_count=eligible_count+p_eligible_delta,status=CASE WHEN p_complete THEN 'completed' ELSE status END,
    completed_at=CASE WHEN p_complete THEN clock_timestamp() ELSE NULL END,
    lease_owner=CASE WHEN p_complete THEN NULL ELSE lease_owner END,
    lease_token=CASE WHEN p_complete THEN NULL ELSE lease_token END,
    lease_acquired_at=CASE WHEN p_complete THEN NULL ELSE lease_acquired_at END,
    lease_expires_at=CASE WHEN p_complete THEN NULL ELSE lease_expires_at END,updated_at=clock_timestamp()
  WHERE id=p_batch_id;
  RETURN true;
END $$;

REVOKE ALL ON app.workspace_control_ledger_projection,app.workspace_legal_holds,
  app.retention_control_audit_facts,app.retention_batches
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}};
REVOKE ALL ON FUNCTION app.reject_retention_control_fact_mutation(),
  app.reject_workspace_legal_hold_mutation(),app.reject_retention_batch_direct_mutation(),
  app.enforce_workspace_retention_control_initial_state(),
  app.enforce_workspace_legal_hold_ledger_links(),
  app.project_workspace_legal_hold(uuid,bigint,uuid,varchar,uuid,char,char,varchar,varchar,varchar,timestamptz),
  app.start_retention_batch(uuid,uuid,varchar,varchar,timestamptz,boolean,varchar,varchar),
  app.claim_retention_batches(varchar,integer,integer),
  app.checkpoint_retention_batch(uuid,uuid,bigint,timestamptz,uuid,integer,integer,boolean) FROM PUBLIC;
-- These pre-existing trigger-only functions retained PostgreSQL's default
-- PUBLIC EXECUTE. Remove it before giving maintenance USAGE on app.
REVOKE ALL ON FUNCTION app.provision_workspace_execution_admission(),
  app.enforce_workflow_run_admission(),app.refresh_workflow_run_admission_counters(),
  app.reject_execution_entitlement_version_mutation(),
  app.reject_failure_notification_destination_version_mutation(),
  app.reject_trigger_schedule_config_mutation(),
  app.reject_webhook_trigger_secret_version_mutation(),
  app.require_new_failure_notification_intent_pin(),
  app.validate_workflow_run_failure_notification_pin() FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO {{maintenance_role}};
GRANT EXECUTE ON FUNCTION
  app.project_workspace_legal_hold(uuid,bigint,uuid,varchar,uuid,char,char,varchar,varchar,varchar,timestamptz),
  app.start_retention_batch(uuid,uuid,varchar,varchar,timestamptz,boolean,varchar,varchar),
  app.claim_retention_batches(varchar,integer,integer),
  app.checkpoint_retention_batch(uuid,uuid,bigint,timestamptz,uuid,integer,integer,boolean)
  TO {{maintenance_role}};

REVOKE UPDATE (retention_control_sequence,retention_control_hash)
  ON app.workspaces FROM {{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}};
