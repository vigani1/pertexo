-- ADR061: all manual API writers serialize one command identity before receipts.
-- The additive case rollout remains off until an operator enables owned compatible
-- deployments; migration-head readiness and the insertion fence reject old writers.
CREATE TABLE app.workflow_input_case_rollout (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false
);
ALTER TABLE app.workflow_input_case_rollout OWNER TO {{owner_role}};
INSERT INTO app.workflow_input_case_rollout(singleton,enabled) VALUES(true,false);
REVOKE ALL ON app.workflow_input_case_rollout FROM PUBLIC,{{api_runtime_role}},
  {{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{lifecycle_command_role}};
GRANT SELECT,UPDATE ON app.workflow_input_case_rollout TO {{operator_role}};

CREATE TABLE app.workflow_manual_start_rejections (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),
  workflow_id uuid NOT NULL,
  scope varchar(128) NOT NULL,
  key_hash char(64) NOT NULL CHECK(key_hash ~ '^[a-f0-9]{64}$'),
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  expected_version_id uuid NOT NULL,
  observed_version_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
  PRIMARY KEY(workspace_id,scope,key_hash),
  FOREIGN KEY(workspace_id,workflow_id) REFERENCES app.workflows(workspace_id,id),
  CHECK(scope='workflow:'||workflow_id::text||':manual'),
  CHECK(expected_version_id<>observed_version_id)
);
ALTER TABLE app.workflow_manual_start_rejections OWNER TO {{owner_role}};
ALTER TABLE app.workflow_manual_start_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_manual_start_rejections FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_manual_start_rejections_tenant ON app.workflow_manual_start_rejections
  TO {{api_runtime_role}} USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY workflow_manual_start_rejections_owner ON app.workflow_manual_start_rejections
  TO {{owner_role}} USING(true) WITH CHECK(true);
REVOKE ALL ON app.workflow_manual_start_rejections FROM PUBLIC,{{api_runtime_role}},
  {{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT SELECT,INSERT ON app.workflow_manual_start_rejections TO {{api_runtime_role}};
CREATE INDEX workflow_manual_start_rejections_expiry_idx
  ON app.workflow_manual_start_rejections(expires_at,workspace_id,scope,key_hash);

CREATE FUNCTION app.lock_manual_workflow_run_start(
  p_actor uuid,p_workflow uuid,p_scope text,p_key_hash text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid:=nullif(current_setting('app.workspace_id',true),'')::uuid;
BEGIN
  IF v_workspace IS NULL OR p_actor::text IS DISTINCT FROM nullif(current_setting('app.actor_id',true),'')
    OR p_scope IS DISTINCT FROM 'workflow:'||p_workflow::text||':manual'
    OR p_key_hash IS NULL OR p_key_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'manual start context denied' USING ERRCODE='PT404';
  END IF;
  PERFORM 1 FROM app.workspaces WHERE id=v_workspace AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'manual start authority denied' USING ERRCODE='PT404'; END IF;
  PERFORM 1 FROM app.users WHERE id=p_actor AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'manual start authority denied' USING ERRCODE='PT404'; END IF;
  PERFORM 1 FROM app.workspace_memberships WHERE workspace_id=v_workspace AND user_id=p_actor
    AND status='active' AND role IN ('owner','admin','builder','operator') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'manual start authority denied' USING ERRCODE='PT404'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'pertexo.manual-start.v1:'||v_workspace::text||':workflow.run.accept:'||p_scope||':'||p_key_hash,1934781131));
  PERFORM set_config('app.manual_start_writer',v_workspace::text||':'||p_workflow::text,true);
END $$;
ALTER FUNCTION app.lock_manual_workflow_run_start(uuid,uuid,text,text) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.lock_manual_workflow_run_start(uuid,uuid,text,text) FROM PUBLIC,
  {{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.lock_manual_workflow_run_start(uuid,uuid,text,text) TO {{api_runtime_role}};

CREATE FUNCTION app.enforce_manual_start_writer() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  -- Privileged fixture/restore writes are not serving runtime admission. Runtime
  -- roles cannot inherit the owner role (startup readiness independently proves it).
  IF NEW.trigger_type='manual' AND NEW.status IN ('queued','running','waiting')
    AND NOT pg_has_role(current_user,
      (SELECT proowner FROM pg_proc WHERE oid='app.lock_manual_workflow_run_start(uuid,uuid,text,text)'::regprocedure),'USAGE')
    AND current_setting('app.manual_start_writer',true) IS DISTINCT FROM
      NEW.workspace_id::text||':'||NEW.workflow_id::text THEN
    RAISE EXCEPTION 'serialized manual start writer required' USING ERRCODE='PTM01';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION app.enforce_manual_start_writer() OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.enforce_manual_start_writer() FROM PUBLIC;
CREATE TRIGGER manual_start_writer_fence BEFORE INSERT ON app.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_manual_start_writer();

CREATE OR REPLACE FUNCTION app.assert_workflow_input_cases_enabled() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
BEGIN
  IF NOT coalesce((SELECT enabled FROM app.workflow_input_case_rollout WHERE singleton),false)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='app.workflow_runs'::regclass
      AND tgname='manual_start_writer_fence' AND tgenabled='O'
      AND tgfoid='app.enforce_manual_start_writer()'::regprocedure AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'workflow input cases unavailable' USING ERRCODE='55000';
  END IF;
END $$;
ALTER FUNCTION app.assert_workflow_input_cases_enabled() OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.assert_workflow_input_cases_enabled() FROM PUBLIC,
  {{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.assert_workflow_input_cases_enabled() TO {{api_runtime_role}};

CREATE FUNCTION app.prune_manual_start_rejections(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid; v_count integer; v_total integer:=0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid manual receipt cleanup page' USING ERRCODE='22023';
  END IF;
  FOR v_workspace IN SELECT DISTINCT workspace_id FROM app.workflow_manual_start_rejections
    WHERE expires_at<=clock_timestamp() ORDER BY workspace_id LIMIT least(p_limit,100)
  LOOP
    -- Never wait for a destruction lock while already holding another tenant's rows.
    IF NOT pg_try_advisory_xact_lock(hashtextextended(v_workspace::text,1934781127)) THEN CONTINUE; END IF;
    PERFORM 1 FROM app.workspaces WHERE id=v_workspace FOR UPDATE;
    IF EXISTS(SELECT 1 FROM app.workspace_legal_holds WHERE workspace_id=v_workspace AND released_sequence IS NULL) THEN CONTINUE; END IF;
    WITH candidates AS (SELECT workspace_id,scope,key_hash FROM app.workflow_manual_start_rejections
      WHERE workspace_id=v_workspace AND expires_at<=clock_timestamp()
      ORDER BY expires_at,scope,key_hash LIMIT least(p_limit,100)-v_total FOR UPDATE SKIP LOCKED)
    DELETE FROM app.workflow_manual_start_rejections receipt USING candidates candidate
      WHERE (receipt.workspace_id,receipt.scope,receipt.key_hash)=(candidate.workspace_id,candidate.scope,candidate.key_hash);
    GET DIAGNOSTICS v_count=ROW_COUNT;
    v_total:=v_total+v_count;
    IF v_total>=least(p_limit,100) THEN EXIT; END IF;
  END LOOP;
  RETURN v_total;
END $$;
ALTER FUNCTION app.prune_manual_start_rejections(integer) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.prune_manual_start_rejections(integer) FROM PUBLIC,
  {{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.prune_manual_start_rejections(integer) TO {{maintenance_role}};

-- Extend existing bounded maintenance counts without changing its public shape.
DO $$ DECLARE v_definition text; v_marker text; v_matches integer; BEGIN
  SELECT pg_get_functiondef('app.reap_transient_data(integer)'::regprocedure) INTO v_definition;
  v_marker:='v_idempotency_records_deleted integer;';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN RAISE EXCEPTION 'transient reaper declaration incompatible (% matches)',v_matches; END IF;
  v_definition:=replace(v_definition,v_marker,v_marker||E'\n  v_manual_start_rejections_deleted integer;');
  v_marker:=E'BEGIN\n';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN RAISE EXCEPTION 'transient reaper entry incompatible (% matches)',v_matches; END IF;
  v_definition:=replace(v_definition,v_marker,v_marker||E'  v_manual_start_rejections_deleted:=app.prune_manual_start_rejections(p_limit);\n');
  v_marker:='GET DIAGNOSTICS v_idempotency_records_deleted = ROW_COUNT;';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN RAISE EXCEPTION 'transient reaper shape incompatible (% matches)',v_matches; END IF;
  EXECUTE replace(v_definition,v_marker,v_marker||E'\n  v_idempotency_records_deleted:=v_idempotency_records_deleted+v_manual_start_rejections_deleted;');
  SELECT pg_get_functiondef('app.execute_workspace_tenant_rows_page_before_input_cases(uuid,uuid,bigint,integer,bigint,character)'::regprocedure) INTO v_definition;
  v_marker:='''workflow_runs'',';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN RAISE EXCEPTION 'tenant purge shape incompatible (% matches)',v_matches; END IF;
  EXECUTE replace(v_definition,v_marker,'''workflow_manual_start_rejections'','||v_marker);
END $$;
