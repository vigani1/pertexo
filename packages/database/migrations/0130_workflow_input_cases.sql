-- ADR061: additive, disabled until all manual writers are fenced by 0131.
CREATE FUNCTION app.assert_workflow_input_cases_enabled() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
BEGIN RAISE EXCEPTION 'run-input cases are not enabled' USING ERRCODE='55000'; END $$;
ALTER FUNCTION app.assert_workflow_input_cases_enabled() OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.assert_workflow_input_cases_enabled() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assert_workflow_input_cases_enabled() TO {{api_runtime_role}};

CREATE TABLE app.workflow_input_cases (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, workflow_id uuid NOT NULL,
  workflow_version_id uuid NOT NULL, version_checksum varchar(77) NOT NULL,
  name varchar(128) NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 128),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), deleted_at timestamptz,
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,workflow_id) REFERENCES app.workflows(workspace_id,id),
  FOREIGN KEY(workspace_id,workflow_id,workflow_version_id)
    REFERENCES app.workflow_versions(workspace_id,workflow_id,id)
);
CREATE INDEX workflow_input_cases_page_idx ON app.workflow_input_cases(workspace_id,workflow_id,created_at,id) WHERE deleted_at IS NULL;
CREATE TABLE app.workflow_input_case_payloads (
  workspace_id uuid NOT NULL,case_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
  input text NOT NULL CHECK(input::jsonb IS NOT NULL),canonical_bytes integer NOT NULL CHECK(canonical_bytes BETWEEN 1 AND 65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,case_id,revision), CHECK(octet_length(input)=canonical_bytes),
  FOREIGN KEY(workspace_id,case_id) REFERENCES app.workflow_input_cases(workspace_id,id)
);
CREATE TABLE app.workflow_input_case_receipts (
  workspace_id uuid NOT NULL REFERENCES app.workspaces(id),actor_id uuid NOT NULL,
  workflow_id uuid NOT NULL,operation varchar(8) NOT NULL CHECK(operation IN ('create','update','delete')),
  key_hash char(64) NOT NULL CHECK(key_hash ~ '^[0-9a-f]{64}$'),
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  case_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
  PRIMARY KEY(workspace_id,actor_id,workflow_id,operation,key_hash),
  CHECK(expires_at>created_at)
);
CREATE INDEX workflow_input_case_receipts_expiry_idx ON app.workflow_input_case_receipts(expires_at,workspace_id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_input_cases','workflow_input_case_payloads','workflow_input_case_receipts'] LOOP
    EXECUTE format('ALTER TABLE app.%I OWNER TO %s',t,'{{owner_role}}');
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO %s USING (workspace_id::text=nullif(current_setting(''app.workspace_id'',true),'''')) WITH CHECK (workspace_id::text=nullif(current_setting(''app.workspace_id'',true),''''))',t||'_tenant',t,'{{api_runtime_role}}');
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO %s USING (true) WITH CHECK (true)',t||'_owner',t,'{{owner_role}}');
    EXECUTE format('GRANT SELECT,INSERT ON app.%I TO %s',t,'{{api_runtime_role}}');
  END LOOP;
END $$;
GRANT UPDATE ON app.workflow_input_cases TO {{api_runtime_role}};

-- Database backstop: API grants cannot bypass rollout, current authority or caps.
CREATE FUNCTION app.guard_workflow_input_case_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_actor uuid; v_workflow uuid; v_count bigint; v_bytes bigint; v_depth integer; v_members bigint;
BEGIN
  -- Compatible writers set this transaction marker only after authority,
  -- command-key, workflow and quota locks. Reject raw UPDATE before waiting
  -- for those locks: PostgreSQL has already acquired its target row lock.
  IF TG_TABLE_NAME='workflow_input_case_payloads' THEN
    SELECT workflow_id INTO v_workflow FROM app.workflow_input_cases WHERE workspace_id=NEW.workspace_id AND id=NEW.case_id AND deleted_at IS NULL;
  ELSE v_workflow:=NEW.workflow_id; END IF;
  IF nullif(current_setting('app.workflow_input_case_writer',true),'') IS DISTINCT FROM NEW.workspace_id::text||':'||v_workflow::text THEN
    RAISE EXCEPTION 'case writer protocol required' USING ERRCODE='55000'; END IF;
  PERFORM app.assert_workflow_input_cases_enabled();
  IF NEW.workspace_id::text IS DISTINCT FROM nullif(current_setting('app.workspace_id',true),'') THEN
    RAISE EXCEPTION 'case workspace mismatch' USING ERRCODE='42501'; END IF;
  v_actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
  PERFORM 1 FROM app.workspaces WHERE id=NEW.workspace_id AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'case workspace inactive' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.users WHERE id=v_actor AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'case actor inactive' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.workspace_memberships WHERE workspace_id=NEW.workspace_id AND user_id=v_actor
    AND status='active' AND role IN ('owner','admin','builder') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'case author inactive' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.workflows WHERE workspace_id=NEW.workspace_id AND id=v_workflow AND lifecycle_status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'case workflow inactive' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workflow-input-case-quota:'||NEW.workspace_id::text,0));
  IF TG_TABLE_NAME='workflow_input_cases' THEN
    IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.workflow_id<>OLD.workflow_id
      OR NEW.workflow_version_id<>OLD.workflow_version_id OR NEW.version_checksum<>OLD.version_checksum
      OR OLD.deleted_at IS NOT NULL OR NEW.revision<>OLD.revision+1) THEN
      RAISE EXCEPTION 'case immutable context or revision invalid' USING ERRCODE='23514'; END IF;
    IF TG_OP='INSERT' THEN
      IF NEW.revision<>1 OR NEW.deleted_at IS NOT NULL OR length(btrim(NEW.name)) NOT BETWEEN 1 AND 128 THEN
        RAISE EXCEPTION 'case initial representation invalid' USING ERRCODE='23514'; END IF;
      SELECT count(*) INTO v_count FROM app.workflow_input_cases WHERE workspace_id=NEW.workspace_id AND deleted_at IS NULL;
      IF v_count>=200 THEN RAISE EXCEPTION 'workspace case count limit' USING ERRCODE='23514'; END IF;
      SELECT count(*) INTO v_count FROM app.workflow_input_cases WHERE workspace_id=NEW.workspace_id AND workflow_id=NEW.workflow_id AND deleted_at IS NULL;
      IF v_count>=20 THEN RAISE EXCEPTION 'workflow case count limit' USING ERRCODE='23514'; END IF;
      PERFORM 1 FROM app.workflow_versions WHERE workspace_id=NEW.workspace_id AND workflow_id=NEW.workflow_id
        AND id=NEW.workflow_version_id AND checksum=NEW.version_checksum;
      IF NOT FOUND THEN RAISE EXCEPTION 'case version mismatch' USING ERRCODE='23514'; END IF;
    END IF;
    v_workflow:=NEW.workflow_id;
  ELSIF TG_TABLE_NAME='workflow_input_case_payloads' THEN
    IF NEW.canonical_bytes NOT BETWEEN 1 AND 65536 OR octet_length(NEW.input)<>NEW.canonical_bytes THEN
      RAISE EXCEPTION 'case canonical byte charge invalid' USING ERRCODE='23514'; END IF;
    SELECT workflow_id INTO v_workflow FROM app.workflow_input_cases WHERE workspace_id=NEW.workspace_id AND id=NEW.case_id AND deleted_at IS NULL;
    SELECT coalesce(sum(canonical_bytes),0) INTO v_bytes FROM app.workflow_input_case_payloads WHERE workspace_id=NEW.workspace_id;
    IF v_bytes+NEW.canonical_bytes>4194304 THEN RAISE EXCEPTION 'retained case byte limit' USING ERRCODE='23514'; END IF;
    WITH RECURSIVE nodes(value,depth) AS (
      SELECT NEW.input::jsonb,0 UNION ALL
      SELECT child.value,parent.depth+1 FROM nodes parent CROSS JOIN LATERAL (
        SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(parent.value)='array' THEN parent.value ELSE '[]'::jsonb END)
        UNION ALL SELECT value FROM jsonb_each(CASE WHEN jsonb_typeof(parent.value)='object' THEN parent.value ELSE '{}'::jsonb END)
      ) child WHERE parent.depth<=64
    ) SELECT max(depth+CASE WHEN jsonb_typeof(value) IN ('object','array') THEN 1 ELSE 0 END),count(*)-1 INTO v_depth,v_members FROM nodes;
    IF v_depth>64 OR v_members>10000 THEN RAISE EXCEPTION 'case JSON structure limit' USING ERRCODE='23514'; END IF;
  ELSE
    IF NEW.actor_id<>v_actor THEN RAISE EXCEPTION 'case receipt actor mismatch' USING ERRCODE='42501'; END IF;
    v_workflow:=NEW.workflow_id;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION app.guard_workflow_input_case_write() OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.guard_workflow_input_case_write() FROM PUBLIC;
CREATE TRIGGER workflow_input_cases_write_guard BEFORE INSERT OR UPDATE ON app.workflow_input_cases FOR EACH ROW EXECUTE FUNCTION app.guard_workflow_input_case_write();
CREATE TRIGGER workflow_input_case_payloads_write_guard BEFORE INSERT ON app.workflow_input_case_payloads FOR EACH ROW EXECUTE FUNCTION app.guard_workflow_input_case_write();
CREATE TRIGGER workflow_input_case_receipts_write_guard BEFORE INSERT ON app.workflow_input_case_receipts FOR EACH ROW EXECUTE FUNCTION app.guard_workflow_input_case_write();

-- Existing destruction lock is acquired before any workspace or case locks.
-- Cleanup only terminal receipts and obsolete/deleted payloads; holds preserve bytes.
CREATE FUNCTION app.reap_workflow_input_cases(p_limit integer DEFAULT 100)
RETURNS TABLE(payloads_deleted integer,receipts_deleted integer,cases_deleted integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_workspace uuid; v_payload integer:=0; v_receipts integer:=0; v_cases integer:=0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'case cleanup limit invalid' USING ERRCODE='22023'; END IF;
  SELECT workspace_id INTO v_workspace FROM (
    SELECT p.workspace_id FROM app.workflow_input_case_payloads p JOIN app.workflow_input_cases c ON c.workspace_id=p.workspace_id AND c.id=p.case_id WHERE c.deleted_at IS NOT NULL OR p.revision<c.revision
    UNION SELECT workspace_id FROM app.workflow_input_case_receipts WHERE expires_at<=clock_timestamp()
    UNION SELECT workspace_id FROM app.workflow_input_cases WHERE deleted_at IS NOT NULL
  ) candidate WHERE NOT EXISTS(SELECT 1 FROM app.workspace_legal_holds hold WHERE hold.workspace_id=candidate.workspace_id AND hold.released_sequence IS NULL) ORDER BY workspace_id LIMIT 1;
  IF v_workspace IS NULL THEN RETURN QUERY SELECT 0,0,0; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_workspace::text,1934781127));
  PERFORM 1 FROM app.workspaces WHERE id=v_workspace FOR UPDATE;
  IF EXISTS(SELECT 1 FROM app.workspace_legal_holds WHERE workspace_id=v_workspace AND released_sequence IS NULL) THEN RETURN QUERY SELECT 0,0,0; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workflow-input-case-quota:'||v_workspace::text,0));
  WITH candidates AS (
    SELECT p.case_id,p.revision,p.canonical_bytes FROM app.workflow_input_case_payloads p JOIN app.workflow_input_cases c ON c.workspace_id=p.workspace_id AND c.id=p.case_id
    WHERE p.workspace_id=v_workspace AND (c.deleted_at IS NOT NULL OR p.revision<c.revision) ORDER BY p.case_id,p.revision LIMIT p_limit FOR UPDATE OF p SKIP LOCKED
  ), bounded AS (SELECT *,sum(canonical_bytes) OVER(ORDER BY case_id,revision) bytes FROM candidates)
  DELETE FROM app.workflow_input_case_payloads p USING bounded b WHERE p.workspace_id=v_workspace AND p.case_id=b.case_id AND p.revision=b.revision AND b.bytes<=1048576;
  GET DIAGNOSTICS v_payload=ROW_COUNT;
  WITH candidates AS (SELECT ctid FROM app.workflow_input_case_receipts WHERE workspace_id=v_workspace AND expires_at<=clock_timestamp() LIMIT p_limit-v_payload FOR UPDATE SKIP LOCKED)
  DELETE FROM app.workflow_input_case_receipts r USING candidates c WHERE r.ctid=c.ctid;
  GET DIAGNOSTICS v_receipts=ROW_COUNT;
  WITH candidates AS (SELECT c.id FROM app.workflow_input_cases c WHERE c.workspace_id=v_workspace AND c.deleted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.workflow_input_case_payloads p WHERE p.workspace_id=c.workspace_id AND p.case_id=c.id) ORDER BY c.id LIMIT p_limit-v_payload-v_receipts FOR UPDATE SKIP LOCKED)
  DELETE FROM app.workflow_input_cases c USING candidates x WHERE c.workspace_id=v_workspace AND c.id=x.id;
  GET DIAGNOSTICS v_cases=ROW_COUNT;
  RETURN QUERY SELECT v_payload,v_receipts,v_cases;
END $$;
ALTER FUNCTION app.reap_workflow_input_cases(integer) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.reap_workflow_input_cases(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reap_workflow_input_cases(integer) TO {{maintenance_role}};

ALTER FUNCTION app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,char) RENAME TO execute_workspace_tenant_rows_page_before_input_cases;
REVOKE ALL ON FUNCTION app.execute_workspace_tenant_rows_page_before_input_cases(uuid,uuid,bigint,integer,bigint,char) FROM {{maintenance_role}},{{operator_role}};
CREATE FUNCTION app.execute_workspace_tenant_rows_page(p_job_id uuid,p_lease_token uuid,p_lease_fence bigint,p_page_size integer,p_projected_sequence bigint,p_projected_hash char(64))
RETURNS TABLE(surface varchar,affected_count integer,completed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE v_job app.workspace_purge_jobs%ROWTYPE; v_step app.workspace_purge_steps%ROWTYPE; v_count integer:=0; v_surface varchar;
BEGIN
  IF p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid purge page'; END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'purge job missing' USING ERRCODE='55000'; END IF;
  -- The existing purge coordinator holds the destruction SESSION lock on a
  -- dedicated client before opening this transaction. Reacquiring it here on
  -- another client would self-deadlock; preserve that maintenance contract.
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  SELECT * INTO v_step FROM app.workspace_purge_steps WHERE job_id=p_job_id AND step_name='tenant_rows' FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'purging' OR v_step.status<>'running' OR v_step.lease_token IS DISTINCT FROM p_lease_token OR v_step.lease_fence IS DISTINCT FROM p_lease_fence OR v_step.lease_expires_at IS NULL OR v_step.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'purge lease stale' USING ERRCODE='55000'; END IF;
  PERFORM 1 FROM app.workspaces WHERE id=v_job.workspace_id AND status='purging' AND retention_control_sequence=p_projected_sequence AND retention_control_hash=p_projected_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'purge high water changed' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM app.workspace_legal_holds WHERE workspace_id=v_job.workspace_id AND released_sequence IS NULL) THEN RAISE EXCEPTION 'legal hold blocks purge' USING ERRCODE='55000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workflow-input-case-quota:'||v_job.workspace_id::text,0));
  WITH candidates AS(SELECT ctid FROM app.workflow_input_case_receipts WHERE workspace_id=v_job.workspace_id LIMIT least(p_page_size,100) FOR UPDATE)
  DELETE FROM app.workflow_input_case_receipts r USING candidates c WHERE r.ctid=c.ctid;
  GET DIAGNOSTICS v_count=ROW_COUNT; v_surface:='workflow_input_case_receipts';
  IF v_count=0 THEN
    WITH candidates AS(SELECT case_id,revision,canonical_bytes FROM app.workflow_input_case_payloads WHERE workspace_id=v_job.workspace_id ORDER BY case_id,revision LIMIT least(p_page_size,100) FOR UPDATE),bounded AS(SELECT *,sum(canonical_bytes) OVER(ORDER BY case_id,revision) bytes FROM candidates)
    DELETE FROM app.workflow_input_case_payloads p USING bounded b WHERE p.workspace_id=v_job.workspace_id AND p.case_id=b.case_id AND p.revision=b.revision AND b.bytes<=1048576;
    GET DIAGNOSTICS v_count=ROW_COUNT; v_surface:='workflow_input_case_payloads';
  END IF;
  IF v_count=0 THEN
    WITH candidates AS(SELECT id FROM app.workflow_input_cases WHERE workspace_id=v_job.workspace_id ORDER BY id LIMIT least(p_page_size,100) FOR UPDATE)
    DELETE FROM app.workflow_input_cases c USING candidates x WHERE c.workspace_id=v_job.workspace_id AND c.id=x.id;
    GET DIAGNOSTICS v_count=ROW_COUNT; v_surface:='workflow_input_cases';
  END IF;
  IF v_count>0 THEN
    PERFORM set_config('app.workspace_purge_transition','on',true);
    UPDATE app.workspace_purge_steps SET status='pending',lease_owner=NULL,lease_token=NULL,
      lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE job_id=p_job_id AND step_name='tenant_rows';
    RETURN QUERY SELECT v_surface,v_count,false; RETURN;
  END IF;
  RETURN QUERY SELECT * FROM app.execute_workspace_tenant_rows_page_before_input_cases(p_job_id,p_lease_token,p_lease_fence,p_page_size,p_projected_sequence,p_projected_hash);
END $$;
ALTER FUNCTION app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,char) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,char) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,char) TO {{maintenance_role}};
