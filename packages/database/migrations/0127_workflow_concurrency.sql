-- ADR 058. Lock order and rollout: docs/operations/workflow-concurrency-enforcement.md.
CREATE TABLE app.workflow_concurrency_policies (
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  active_run_limit integer CHECK(active_run_limit BETWEEN 1 AND 10000),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  PRIMARY KEY(workspace_id,workflow_id),
  FOREIGN KEY(workspace_id,workflow_id) REFERENCES app.workflows(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE app.workflow_concurrency_command_receipts (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  key_hash text NOT NULL,
  request_hash text NOT NULL,
  result jsonb,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
  PRIMARY KEY(workspace_id,actor_id,workflow_id,key_hash)
);
CREATE INDEX workflow_concurrency_receipts_expiry_idx
  ON app.workflow_concurrency_command_receipts(expires_at) WHERE result IS NOT NULL;
ALTER TABLE app.workflow_concurrency_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_concurrency_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_concurrency_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_concurrency_command_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_concurrency_policies_owner ON app.workflow_concurrency_policies
  FOR ALL TO {{owner_role}} USING(true) WITH CHECK(true);
CREATE POLICY workflow_concurrency_receipts_owner ON app.workflow_concurrency_command_receipts
  FOR ALL TO {{owner_role}} USING(true) WITH CHECK(true);
REVOKE ALL ON app.workflow_concurrency_policies,app.workflow_concurrency_command_receipts
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};

CREATE SEQUENCE app.workflow_run_admission_ticket_seq AS bigint;
ALTER SEQUENCE app.workflow_run_admission_ticket_seq OWNER TO {{owner_role}};
REVOKE ALL ON SEQUENCE app.workflow_run_admission_ticket_seq FROM PUBLIC,
  {{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},
  {{operator_role}},{{lifecycle_command_role}};
ALTER TABLE app.workflow_runs ADD COLUMN admission_ticket bigint DEFAULT NULL;
-- Deterministic legacy order, explicitly not a reconstructed acceptance history.
WITH ordered AS (SELECT id,row_number() OVER(ORDER BY created_at,id) AS ticket FROM app.workflow_runs)
UPDATE app.workflow_runs run SET admission_ticket=ordered.ticket FROM ordered WHERE run.id=ordered.id;
SELECT setval('app.workflow_run_admission_ticket_seq',
  greatest(coalesce((SELECT max(admission_ticket) FROM app.workflow_runs),0),1),
  EXISTS(SELECT 1 FROM app.workflow_runs));
ALTER TABLE app.workflow_runs ALTER COLUMN admission_ticket SET NOT NULL;
ALTER TABLE app.workflow_runs ADD CONSTRAINT workflow_runs_admission_ticket_positive CHECK(admission_ticket>0);
CREATE INDEX workflow_runs_queued_admission_order_idx ON app.workflow_runs
  (workspace_id,workflow_id,admission_ticket,id) WHERE status='queued';
CREATE INDEX workflow_runs_workflow_active_idx ON app.workflow_runs
  (workspace_id,workflow_id,id) WHERE status IN ('running','waiting');
ALTER TABLE app.workflow_run_active_admissions
  ADD COLUMN workflow_concurrency_order_exempt boolean NOT NULL DEFAULT true;

-- Internal predicate: all occupancy/order data is authoritative PostgreSQL state.
-- Callers serialize grants/transitions using the existing workspace counter.
CREATE FUNCTION app.workflow_concurrency_admissible(p_workspace uuid,p_run uuid,p_grant boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_run app.workflow_runs%ROWTYPE; v_limit integer; v_reserved boolean; v_exempt boolean;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_run FROM app.workflow_runs WHERE workspace_id=p_workspace AND id=p_run;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_run.status<>'queued' THEN RETURN true; END IF;
  SELECT active_run_limit INTO v_limit FROM app.workflow_concurrency_policies
    WHERE workspace_id=p_workspace AND workflow_id=v_run.workflow_id;
  IF v_limit IS NULL THEN RETURN true; END IF;
  IF current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
    IF p_grant THEN RETURN false; END IF;
    RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
  END IF;
  SELECT true,workflow_concurrency_order_exempt INTO v_reserved,v_exempt
    FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace AND workflow_run_id=p_run;
  -- A committed slot survives lowering/enabling; an order-exempt slot predates
  -- ordered grants. Controls cannot use this predicate to start node work.
  IF v_reserved AND (p_grant OR v_exempt) THEN RETURN true; END IF;
  IF NOT coalesce(v_reserved,false) AND
    (SELECT count(*) FROM app.workflow_runs WHERE workspace_id=p_workspace
      AND workflow_id=v_run.workflow_id AND status IN ('running','waiting'))+
    (SELECT count(*) FROM app.workflow_run_active_admissions admission
      JOIN app.workflow_runs run ON run.workspace_id=admission.workspace_id AND run.id=admission.workflow_run_id
      WHERE admission.workspace_id=p_workspace AND run.workflow_id=v_run.workflow_id)>=v_limit THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS(SELECT 1 FROM app.workflow_runs earlier
    WHERE earlier.workspace_id=p_workspace AND earlier.workflow_id=v_run.workflow_id
      AND earlier.status='queued' AND earlier.admission_ticket<v_run.admission_ticket
      AND earlier.cancel_requested_at IS NULL AND (earlier.deadline_at IS NULL OR earlier.deadline_at>clock_timestamp())
      AND NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
        WHERE admission.workspace_id=p_workspace AND admission.workflow_run_id=earlier.id
          AND (p_grant OR admission.workflow_concurrency_order_exempt)));
END $$;

-- Purge the new operational state/receipts through the existing bounded,
-- workspace-first and legal-hold-aware tenant-row purge owner.
DO $$
DECLARE v_definition text; v_marker text; v_matches integer;
BEGIN
  SELECT pg_get_functiondef('app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)'::regprocedure) INTO v_definition;
  v_marker:='''workflow_auto_pause_command_receipts''';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN RAISE EXCEPTION 'workspace tenant purge shape incompatible'; END IF;
  EXECUTE replace(v_definition,v_marker,
    '''workflow_concurrency_policies'', ''workflow_concurrency_command_receipts'', '||v_marker);
END $$;
ALTER FUNCTION app.workflow_concurrency_admissible(uuid,uuid,boolean) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.workflow_concurrency_admissible(uuid,uuid,boolean) FROM PUBLIC,
  {{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},
  {{operator_role}},{{lifecycle_command_role}};

-- Replace only the reviewed current trigger shape; fail migration on drift.
DO $$
DECLARE v_definition text; v_marker text; v_matches integer;
BEGIN
  SELECT pg_get_functiondef('app.enforce_workflow_run_admission()'::regprocedure) INTO v_definition;
  v_marker:='  SELECT status INTO workspace_status FROM app.workspaces';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN RAISE EXCEPTION 'admission trigger shape incompatible'; END IF;
  v_definition:=replace(v_definition,v_marker,'  IF TG_OP=''UPDATE'' AND NEW.admission_ticket IS DISTINCT FROM OLD.admission_ticket THEN
    RAISE EXCEPTION ''admission ticket is immutable'' USING ERRCODE=''55000'';
  END IF;
  IF TG_OP=''INSERT'' AND NEW.status IN (''running'',''waiting'')
     AND EXISTS(SELECT 1 FROM app.workflow_concurrency_policies WHERE workspace_id=NEW.workspace_id
       AND workflow_id=NEW.workflow_id AND active_run_limit IS NOT NULL) THEN
    IF current_setting(''app.workflow_concurrency_protocol'',true) IS DISTINCT FROM ''1'' THEN
      RAISE EXCEPTION ''workflow concurrency protocol required'' USING ERRCODE=''PTC01'';
    END IF;
    RAISE EXCEPTION ''capped production runs must enter the durable queue'' USING ERRCODE=''PTC02'';
  END IF;
  IF TG_OP=''UPDATE'' AND OLD.status=''queued'' AND NEW.status IN (''running'',''waiting'')
     AND (OLD.cancel_requested_at IS NOT NULL OR OLD.deadline_at<=clock_timestamp()) THEN
    RAISE EXCEPTION ''terminal control cannot start work'' USING ERRCODE=''PTC02'';
  END IF;
  IF TG_OP=''UPDATE'' AND OLD.status=''queued'' AND NEW.status IN (''running'',''waiting'')
     AND EXISTS(SELECT 1 FROM app.workflow_concurrency_policies WHERE workspace_id=NEW.workspace_id
       AND workflow_id=NEW.workflow_id AND active_run_limit IS NOT NULL)
     AND current_setting(''app.workflow_concurrency_protocol'',true) IS DISTINCT FROM ''1'' THEN
    RAISE EXCEPTION ''workflow concurrency protocol required'' USING ERRCODE=''PTC01'';
  END IF;
'||v_marker);
  v_marker:='  SELECT count(*) FILTER(WHERE status=''queued'')::integer,';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN RAISE EXCEPTION 'admission count shape incompatible'; END IF;
  v_definition:=replace(v_definition,v_marker,'  IF TG_OP=''INSERT'' THEN
    NEW.admission_ticket:=nextval(''app.workflow_run_admission_ticket_seq'');
  END IF;
'||v_marker);
  v_marker:='  RETURN NEW;';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN RAISE EXCEPTION 'admission return shape incompatible'; END IF;
  EXECUTE replace(v_definition,v_marker,'  IF TG_OP=''UPDATE'' AND OLD.status=''queued'' AND NEW.status IN (''running'',''waiting'')
     AND NOT app.workflow_concurrency_admissible(NEW.workspace_id,NEW.id,false) THEN
    RAISE EXCEPTION ''workflow concurrency admission blocked'' USING ERRCODE=''PTC02'';
  END IF;
'||v_marker);
END $$;

CREATE OR REPLACE FUNCTION app.workflow_run_active_capacity_available(
  p_workspace_id uuid,p_entitlement_version integer,p_workflow_run_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE active_limit integer; active_count integer; reserved_count integer; workspace_status text;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  -- Protocol rejection precedes the counter, including for old lock-owning workers.
  IF NOT app.workflow_concurrency_admissible(p_workspace_id,p_workflow_run_id,false) THEN RETURN false; END IF;
  SELECT version.active_run_limit INTO active_limit
    FROM app.workspace_execution_admission_counters counter
    JOIN app.workspace_execution_entitlement_versions version ON version.workspace_id=counter.workspace_id
      AND version.version=p_entitlement_version
    WHERE counter.workspace_id=p_workspace_id FOR UPDATE OF counter;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01'; END IF;
  IF NOT app.workflow_concurrency_admissible(p_workspace_id,p_workflow_run_id,false) THEN RETURN false; END IF;
  SELECT count(*)::integer INTO active_count FROM app.workflow_runs
    WHERE workspace_id=p_workspace_id AND status IN ('running','waiting');
  SELECT count(*)::integer INTO reserved_count FROM app.workflow_run_active_admissions
    WHERE workspace_id=p_workspace_id AND workflow_run_id<>p_workflow_run_id;
  SELECT status INTO workspace_status FROM app.workspaces WHERE id=p_workspace_id;
  RETURN workspace_status='active' AND active_count+reserved_count<active_limit;
END $$;

CREATE OR REPLACE FUNCTION app.workflow_run_active_admission_eligible(
  p_workspace_id uuid,p_outbox_event_id uuid,p_workflow_run_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE v_run app.workflow_runs%ROWTYPE; v_prior text; v_status text; v_limit integer; v_result boolean:=false;
BEGIN
  v_prior:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  SELECT run.* INTO v_run FROM app.workflow_runs run JOIN app.outbox_events event
    ON event.id=p_outbox_event_id AND event.workspace_id=run.workspace_id
      AND event.aggregate_type='workflow-run' AND event.aggregate_id=run.id AND event.job_name='advance-workflow-run'
    WHERE run.workspace_id=p_workspace_id AND run.id=p_workflow_run_id;
  IF FOUND THEN
    IF v_run.status<>'queued' OR v_run.cancel_requested_at IS NOT NULL OR v_run.deadline_at<=clock_timestamp() THEN
      v_result:=true;
    ELSE
      SELECT status INTO v_status FROM app.workspaces WHERE id=p_workspace_id;
      SELECT active_run_limit INTO v_limit FROM app.workspace_execution_entitlement_versions
        WHERE workspace_id=p_workspace_id AND version=v_run.execution_entitlement_version;
      v_result:=v_status='active' AND app.workflow_concurrency_admissible(p_workspace_id,p_workflow_run_id,true)
        AND (EXISTS(SELECT 1 FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace_id
          AND workflow_run_id=p_workflow_run_id AND outbox_event_id=p_outbox_event_id)
        OR (NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id)
          AND (SELECT count(*) FROM app.workflow_runs WHERE workspace_id=p_workspace_id AND status IN ('running','waiting'))+
            (SELECT count(*) FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace_id)<v_limit));
    END IF;
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RETURN coalesce(v_result,false);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RAISE;
END $$;

CREATE OR REPLACE FUNCTION app.reserve_workflow_run_active_admission(
  p_workspace_id uuid,p_outbox_event_id uuid,p_workflow_run_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE v_run app.workflow_runs%ROWTYPE; v_prior text; v_result boolean:=false; v_limit integer;
BEGIN
  v_prior:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  -- Before the counter: never wait for the FK run lock with the counter held.
  -- The reservation also references workspace; take that FK lock first, so
  -- workspace-first lifecycle/purge cannot invert workspace and run locks.
  PERFORM 1 FROM app.workspaces WHERE id=p_workspace_id FOR KEY SHARE SKIP LOCKED;
  IF NOT FOUND THEN
    PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RETURN false;
  END IF;
  SELECT run.* INTO v_run FROM app.workflow_runs run JOIN app.outbox_events event
    ON event.id=p_outbox_event_id AND event.workspace_id=run.workspace_id
      AND event.aggregate_type='workflow-run' AND event.aggregate_id=run.id AND event.job_name='advance-workflow-run'
    WHERE run.workspace_id=p_workspace_id AND run.id=p_workflow_run_id FOR KEY SHARE OF run SKIP LOCKED;
  IF FOUND THEN
    IF v_run.status<>'queued' OR v_run.cancel_requested_at IS NOT NULL OR v_run.deadline_at<=clock_timestamp() THEN
      v_result:=true;
    ELSE
      IF NOT app.workflow_concurrency_admissible(p_workspace_id,p_workflow_run_id,true) THEN
        PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RETURN false;
      END IF;
      PERFORM 1 FROM app.workspace_execution_admission_counters WHERE workspace_id=p_workspace_id FOR UPDATE;
      IF FOUND AND app.workflow_run_active_admission_eligible(p_workspace_id,p_outbox_event_id,p_workflow_run_id) THEN
        INSERT INTO app.workflow_run_active_admissions(workspace_id,workflow_run_id,outbox_event_id,workflow_concurrency_order_exempt)
          SELECT p_workspace_id,p_workflow_run_id,p_outbox_event_id,
            NOT EXISTS(SELECT 1 FROM app.workflow_concurrency_policies WHERE workspace_id=p_workspace_id
              AND workflow_id=v_run.workflow_id AND active_run_limit IS NOT NULL)
          WHERE NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id);
        v_result:=true;
      END IF;
    END IF;
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RETURN v_result;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RAISE;
END $$;

CREATE FUNCTION app.workflow_concurrency_control(
  p_workspace uuid,p_actor uuid,p_workflow uuid,p_operation text,p_request jsonb,
  p_key_hash text,p_request_hash text,p_request_id text,p_trace_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_role text; v_limit integer; v_revision integer; v_maximum integer; v_state text;
  v_entitlement record; v_receipt app.workflow_concurrency_command_receipts%ROWTYPE; v_settings jsonb;
BEGIN
  IF p_workspace::text IS DISTINCT FROM nullif(current_setting('app.workspace_id',true),'')
    OR p_actor::text IS DISTINCT FROM nullif(current_setting('app.actor_id',true),'') THEN
    RAISE EXCEPTION 'concurrency context denied' USING ERRCODE='PT404';
  END IF;
  IF p_operation NOT IN ('read','update') OR p_request IS NULL OR jsonb_typeof(p_request)<>'object'
    OR (p_operation='read' AND p_request<>'{}'::jsonb)
    OR (p_operation='update' AND (NOT p_request ? 'limit'
      OR (p_request->>'expectedRevision') IS NULL OR (p_request->>'expectedRevision')::integer<1
      OR (p_request->>'limit' IS NOT NULL AND (p_request->>'limit')::integer NOT BETWEEN 1 AND 10000)
      OR p_request-ARRAY['limit','expectedRevision']<>'{}'::jsonb)) THEN
    RAISE EXCEPTION 'invalid concurrency command' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM app.workspaces WHERE id=p_workspace AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace not visible' USING ERRCODE='PT404'; END IF;
  SELECT membership.role INTO v_role FROM app.workspace_memberships membership
    JOIN app.users actor ON actor.id=membership.user_id
    WHERE membership.workspace_id=p_workspace AND membership.user_id=p_actor
      AND membership.status='active' AND actor.status='active' FOR SHARE OF membership,actor;
  IF NOT FOUND OR (p_operation='update' AND v_role NOT IN ('owner','admin','builder')) THEN
    RAISE EXCEPTION 'workflow not visible' USING ERRCODE='PT404';
  END IF;
  PERFORM 1 FROM app.workflows WHERE workspace_id=p_workspace AND id=p_workflow FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow not visible' USING ERRCODE='PT404'; END IF;
  IF p_operation='update' THEN
    IF p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$' OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'command hashes required' USING ERRCODE='22023';
    END IF;
    INSERT INTO app.workflow_concurrency_command_receipts(workspace_id,actor_id,workflow_id,key_hash,request_hash)
      VALUES(p_workspace,p_actor,p_workflow,p_key_hash,p_request_hash) ON CONFLICT DO NOTHING;
    SELECT * INTO STRICT v_receipt FROM app.workflow_concurrency_command_receipts
      WHERE workspace_id=p_workspace AND actor_id=p_actor AND workflow_id=p_workflow AND key_hash=p_key_hash FOR UPDATE;
    IF v_receipt.request_hash<>p_request_hash THEN RAISE EXCEPTION 'concurrency idempotency conflict' USING ERRCODE='PT409'; END IF;
    IF v_receipt.result IS NOT NULL THEN RETURN jsonb_build_object('settings',v_receipt.result,'replayed',true); END IF;
    PERFORM 1 FROM app.workspace_execution_entitlements current
      JOIN app.workspace_execution_entitlement_versions version ON version.workspace_id=current.workspace_id
        AND version.version=current.current_version WHERE current.workspace_id=p_workspace FOR SHARE OF current,version;
    PERFORM 1 FROM app.workspace_execution_admission_counters WHERE workspace_id=p_workspace FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'workspace admission unavailable' USING ERRCODE='PTA01'; END IF;
  END IF;
  SELECT version.* INTO v_entitlement FROM app.workspace_execution_entitlements current
    JOIN app.workspace_execution_entitlement_versions version ON version.workspace_id=current.workspace_id AND version.version=current.current_version
    WHERE current.workspace_id=p_workspace;
  v_state:=CASE WHEN NOT FOUND THEN 'unavailable' WHEN v_entitlement.status='suspended' THEN 'suspended'
    WHEN v_entitlement.effective_at>clock_timestamp() THEN 'not_yet_effective'
    WHEN v_entitlement.expires_at IS NOT NULL AND v_entitlement.expires_at<=clock_timestamp() THEN 'expired' ELSE 'active' END;
  v_maximum:=CASE WHEN v_state='active' THEN v_entitlement.active_run_limit ELSE NULL END;
  SELECT active_run_limit,revision INTO v_limit,v_revision FROM app.workflow_concurrency_policies
    WHERE workspace_id=p_workspace AND workflow_id=p_workflow;
  v_revision:=coalesce(v_revision,1);
  IF p_operation='update' THEN
    IF v_revision<>(p_request->>'expectedRevision')::integer THEN
      RAISE EXCEPTION 'concurrency revision conflict' USING ERRCODE='PTC09',DETAIL=v_revision::text;
    END IF;
    IF p_request->>'limit' IS NOT NULL AND v_maximum IS NULL THEN
      RAISE EXCEPTION 'active workspace entitlement required' USING ERRCODE='PTC10';
    END IF;
    IF (p_request->>'limit')::integer>v_maximum THEN
      RAISE EXCEPTION 'workflow limit exceeds workspace limit' USING ERRCODE='PTC11',DETAIL=v_maximum::text;
    END IF;
    IF v_limit IS DISTINCT FROM (p_request->>'limit')::integer THEN
      v_limit:=(p_request->>'limit')::integer; v_revision:=v_revision+1;
      INSERT INTO app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit,revision)
        VALUES(p_workspace,p_workflow,v_limit,v_revision)
        ON CONFLICT(workspace_id,workflow_id) DO UPDATE SET active_run_limit=excluded.active_run_limit,revision=excluded.revision;
      INSERT INTO app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
        VALUES(gen_random_uuid(),p_workspace,p_actor,'workflow.concurrency_settings_changed','workflow',p_workflow,p_request_id,p_trace_id,
          jsonb_build_object('limit',v_limit,'revision',v_revision,'overflow','queue'));
    END IF;
  END IF;
  v_settings:=jsonb_build_object('asOf',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'limit',v_limit,'revision',v_revision,'workspaceActiveRunLimit',v_maximum,'workspacePolicyState',v_state,'overflow','queue');
  IF p_operation='read' THEN RETURN v_settings; END IF;
  UPDATE app.workflow_concurrency_command_receipts SET result=v_settings
    WHERE workspace_id=p_workspace AND actor_id=p_actor AND workflow_id=p_workflow AND key_hash=p_key_hash;
  RETURN jsonb_build_object('settings',v_settings,'replayed',false);
END $$;
ALTER FUNCTION app.workflow_concurrency_control(uuid,uuid,uuid,text,jsonb,text,text,text,text) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.workflow_concurrency_control(uuid,uuid,uuid,text,jsonb,text,text,text,text)
  FROM PUBLIC,{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.workflow_concurrency_control(uuid,uuid,uuid,text,jsonb,text,text,text,text) TO {{api_runtime_role}};

-- A current read projection, not a promised start time or persisted run status.
CREATE FUNCTION app.workflow_run_admission_blockers(p_workspace uuid,p_run uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_run app.workflow_runs%ROWTYPE; v_limit integer; v_workspace_limit integer;
  v_reserved boolean; v_exempt boolean; v_reasons text[]:=ARRAY[]::text[];
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_run FROM app.workflow_runs WHERE workspace_id=p_workspace AND id=p_run;
  IF NOT FOUND OR v_run.status<>'queued' OR v_run.cancel_requested_at IS NOT NULL
    OR v_run.deadline_at<=statement_timestamp() THEN RETURN NULL; END IF;
  SELECT true,workflow_concurrency_order_exempt INTO v_reserved,v_exempt
    FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace AND workflow_run_id=p_run;
  SELECT active_run_limit INTO v_workspace_limit FROM app.workspace_execution_entitlement_versions
    WHERE workspace_id=p_workspace AND version=v_run.execution_entitlement_version;
  IF NOT coalesce(v_reserved,false) AND (SELECT count(*) FROM app.workflow_runs
      WHERE workspace_id=p_workspace AND status IN ('running','waiting'))+
    (SELECT count(*) FROM app.workflow_run_active_admissions WHERE workspace_id=p_workspace)>=v_workspace_limit THEN
    v_reasons:=array_append(v_reasons,'workspace_capacity');
  END IF;
  SELECT active_run_limit INTO v_limit FROM app.workflow_concurrency_policies
    WHERE workspace_id=p_workspace AND workflow_id=v_run.workflow_id;
  IF v_limit IS NOT NULL THEN
    IF NOT coalesce(v_reserved,false) AND (SELECT count(*) FROM app.workflow_runs
        WHERE workspace_id=p_workspace AND workflow_id=v_run.workflow_id AND status IN ('running','waiting'))+
      (SELECT count(*) FROM app.workflow_run_active_admissions admission JOIN app.workflow_runs run
        ON run.workspace_id=admission.workspace_id AND run.id=admission.workflow_run_id
        WHERE admission.workspace_id=p_workspace AND run.workflow_id=v_run.workflow_id)>=v_limit THEN
      v_reasons:=array_append(v_reasons,'workflow_capacity');
    END IF;
    IF NOT coalesce(v_exempt,false) AND EXISTS(SELECT 1 FROM app.workflow_runs earlier
      WHERE earlier.workspace_id=p_workspace AND earlier.workflow_id=v_run.workflow_id
        AND earlier.status='queued' AND earlier.admission_ticket<v_run.admission_ticket
        AND earlier.cancel_requested_at IS NULL AND (earlier.deadline_at IS NULL OR earlier.deadline_at>statement_timestamp())
        AND NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
          WHERE admission.workspace_id=p_workspace AND admission.workflow_run_id=earlier.id
            AND admission.workflow_concurrency_order_exempt)) THEN
      v_reasons:=array_append(v_reasons,'workflow_order');
    END IF;
  END IF;
  RETURN jsonb_build_object('asOf',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'reasons',to_jsonb(v_reasons));
END $$;
ALTER FUNCTION app.workflow_run_admission_blockers(uuid,uuid) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.workflow_run_admission_blockers(uuid,uuid)
  FROM PUBLIC,{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.workflow_run_admission_blockers(uuid,uuid) TO {{api_runtime_role}};

-- Keep the existing bounded, legal-hold-aware transient reaper as receipt owner.
DO $$
DECLARE v_definition text; v_marker text; v_matches integer;
BEGIN
  SELECT pg_get_functiondef('app.reap_transient_data(integer)'::regprocedure) INTO v_definition;
  v_marker:='GET DIAGNOSTICS v_idempotency_records_deleted = ROW_COUNT;';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN RAISE EXCEPTION 'transient reaper shape incompatible'; END IF;
  EXECUTE replace(v_definition,v_marker,v_marker||'
  WITH candidates AS (
    SELECT receipt.workspace_id,receipt.actor_id,receipt.workflow_id,receipt.key_hash
      FROM app.workflow_concurrency_command_receipts receipt WHERE receipt.result IS NOT NULL
        AND receipt.expires_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM app.workspace_legal_holds hold
          WHERE hold.workspace_id=receipt.workspace_id AND hold.released_sequence IS NULL)
      ORDER BY receipt.expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM app.workflow_concurrency_command_receipts receipt USING candidates
      WHERE receipt.workspace_id=candidates.workspace_id AND receipt.actor_id=candidates.actor_id
        AND receipt.workflow_id=candidates.workflow_id AND receipt.key_hash=candidates.key_hash RETURNING 1
  ) SELECT v_idempotency_records_deleted+count(*)::integer INTO v_idempotency_records_deleted FROM deleted;');
END $$;
