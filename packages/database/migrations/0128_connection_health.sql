-- ADR059: accepted execution evidence, never a free-standing worker health setter.
ALTER TABLE app.connections
  ADD COLUMN health_revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN last_run_observed_at timestamptz,
  ADD COLUMN last_health_transition_at timestamptz,
  ADD COLUMN last_health_transition_source varchar(16),
  ADD CONSTRAINT connections_health_revision_positive CHECK (health_revision>0),
  ADD CONSTRAINT connections_health_transition_source_valid CHECK
    (((last_health_transition_at IS NULL AND last_health_transition_source IS NULL)
      OR (last_health_transition_at IS NOT NULL AND last_health_transition_source IN ('run','test','rotation','revoke'))) IS TRUE),
  DROP CONSTRAINT connections_health_time_order;
ALTER TABLE app.connection_events DROP CONSTRAINT connection_events_type_valid,
  ADD CONSTRAINT connection_events_type_valid CHECK (event_type IN (
    'connection.created','connection.secret_rotated','connection.test_succeeded',
    'connection.test_failed','connection.reauthorization_required','connection.revoked',
    'connection.credential_accessed','connection.health_changed'));

CREATE TABLE app.node_attempt_connection_dispatches (
  workspace_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider_key varchar(64) NOT NULL CHECK (provider_key='slack'),
  auth_type varchar(64) NOT NULL CHECK (auth_type='slack_bot_token'),
  secret_version_id uuid NOT NULL,
  health_revision bigint NOT NULL CHECK (health_revision>0),
  worker_id varchar(128) NOT NULL,
  fence_token bigint NOT NULL CHECK (fence_token>0),
  PRIMARY KEY(workspace_id,attempt_id),
  CONSTRAINT node_attempt_connection_dispatches_attempt_fk FOREIGN KEY(workspace_id,attempt_id)
    REFERENCES app.node_attempts(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE app.connection_health_observations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  kind varchar(32) NOT NULL,
  reason_code varchar(128),
  production_mode varchar(16) NOT NULL CHECK (production_mode IN ('observe','enforce')),
  outbox_event_id uuid NOT NULL UNIQUE,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  CONSTRAINT connection_health_observations_attempt_unique UNIQUE(workspace_id,attempt_id),
  CONSTRAINT connection_health_observations_dispatch_fk FOREIGN KEY(workspace_id,attempt_id)
    REFERENCES app.node_attempt_connection_dispatches(workspace_id,attempt_id) ON DELETE CASCADE,
  CONSTRAINT connection_health_observations_signal_valid CHECK
    ((kind='healthy' AND reason_code IS NULL) OR (kind='reauthorization_required' AND reason_code IS NOT NULL
      AND reason_code IN ('connection.slack_account_inactive','connection.slack_token_expired','connection.slack_token_revoked')))
);
CREATE INDEX connection_health_observations_workspace_time_idx
  ON app.connection_health_observations(workspace_id,observed_at,id);
ALTER TABLE app.node_attempt_connection_dispatches OWNER TO {{owner_role}};
ALTER TABLE app.connection_health_observations OWNER TO {{owner_role}};
ALTER TABLE app.node_attempt_connection_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.node_attempt_connection_dispatches FORCE ROW LEVEL SECURITY;
ALTER TABLE app.connection_health_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connection_health_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY node_attempt_connection_dispatches_workspace_scope ON app.node_attempt_connection_dispatches
  FOR ALL TO {{owner_role}},{{worker_runtime_role}}
  USING (workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY connection_health_observations_workspace_scope ON app.connection_health_observations
  FOR ALL TO {{owner_role}},{{worker_runtime_role}}
  USING (workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK (workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
REVOKE ALL ON app.node_attempt_connection_dispatches,app.connection_health_observations
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT SELECT ON app.node_attempt_connection_dispatches,app.connection_health_observations TO {{worker_runtime_role}};
GRANT UPDATE(health_revision,last_run_observed_at,last_health_transition_at,last_health_transition_source)
  ON app.connections TO {{api_runtime_role}};
REVOKE UPDATE(status,last_tested_at,last_healthy_at,last_error_code,updated_at) ON app.connections FROM {{worker_runtime_role}};
REVOKE INSERT ON app.connection_events FROM {{worker_runtime_role}};
CREATE POLICY inbox_receipts_connection_health_owner_select ON app.inbox_receipts
  FOR SELECT TO {{owner_role}} USING (workspace_id::text=nullif(current_setting('app.workspace_id',true),'')
    AND consumer_name='connection-health-worker');
-- A real execution also has coordinator/attempt receipts. The existing tenant
-- purge must remove all of them, only while its leased delete capability is armed.
CREATE POLICY inbox_receipts_owner_leased_purge_select ON app.inbox_receipts
  FOR SELECT TO {{owner_role}} USING (workspace_id::text=nullif(current_setting('app.workspace_id',true),'')
    AND app.workspace_purge_immutable_delete_is_armed(workspace_id));
CREATE POLICY inbox_receipts_owner_leased_purge_delete ON app.inbox_receipts
  FOR DELETE TO {{owner_role}} USING (workspace_id::text=nullif(current_setting('app.workspace_id',true),'')
    AND app.workspace_purge_immutable_delete_is_armed(workspace_id));
-- SELECT FOR UPDATE in the existing bounded delete page also needs an UPDATE
-- policy. This no-login owner policy is inert outside that same leased purge.
CREATE POLICY inbox_receipts_owner_leased_purge_lock ON app.inbox_receipts
  FOR UPDATE TO {{owner_role}} USING (workspace_id::text=nullif(current_setting('app.workspace_id',true),'')
    AND app.workspace_purge_immutable_delete_is_armed(workspace_id))
  WITH CHECK (workspace_id::text=nullif(current_setting('app.workspace_id',true),'')
    AND app.workspace_purge_immutable_delete_is_armed(workspace_id));
CREATE POLICY outbox_events_connection_health_owner_delete ON app.outbox_events
  FOR DELETE TO {{owner_role}} USING (workspace_id::text=nullif(current_setting('app.workspace_id',true),'')
    AND job_name='apply-connection-health-observation');
CREATE POLICY outbox_events_owner_leased_purge_delete ON app.outbox_events
  FOR DELETE TO {{owner_role}} USING (workspace_id::text=nullif(current_setting('app.workspace_id',true),'')
    AND app.workspace_purge_immutable_delete_is_armed(workspace_id));

CREATE FUNCTION app.enforce_connection_health_protocol() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
  IF NEW.health_revision<OLD.health_revision OR (OLD.status='revoked' AND NEW.status<>'revoked') THEN
    RAISE EXCEPTION 'connection revision and revocation are monotonic' USING ERRCODE='PTH06';
  END IF;
  IF (NEW.status,NEW.current_secret_version_id,NEW.last_tested_at,NEW.last_healthy_at,NEW.last_error_code,
      NEW.health_revision,NEW.last_run_observed_at,NEW.last_health_transition_at,NEW.last_health_transition_source)
    IS DISTINCT FROM
     (OLD.status,OLD.current_secret_version_id,OLD.last_tested_at,OLD.last_healthy_at,OLD.last_error_code,
      OLD.health_revision,OLD.last_run_observed_at,OLD.last_health_transition_at,OLD.last_health_transition_source)
    AND current_setting('app.connection_health_protocol',true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'connection health requires revision-aware writer' USING ERRCODE='PTH01';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connections_health_protocol BEFORE UPDATE ON app.connections
  FOR EACH ROW EXECUTE FUNCTION app.enforce_connection_health_protocol();

CREATE FUNCTION app.bind_node_attempt_connection_dispatch(
  p_workspace uuid,p_attempt uuid,p_worker text,p_fence bigint,
  p_connection uuid,p_secret uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE v_revision bigint; v_node text; v_version uuid; v_existing app.node_attempt_connection_dispatches%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'connection dispatch tenant mismatch' USING ERRCODE='PTH02';
  END IF;
  SELECT connection.health_revision INTO v_revision FROM app.connections connection
    JOIN app.workspaces workspace ON workspace.id=connection.workspace_id
    WHERE connection.workspace_id=p_workspace AND connection.id=p_connection
      AND connection.provider_key='slack' AND connection.auth_type='slack_bot_token'
      AND connection.current_secret_version_id=p_secret AND connection.status='active' AND workspace.status='active'
    FOR SHARE OF connection;
  IF NOT FOUND THEN RAISE EXCEPTION 'connection dispatch fence mismatch' USING ERRCODE='PTH02'; END IF;
  SELECT node.node_id,run.workflow_version_id INTO v_node,v_version
    FROM app.node_attempts attempt JOIN app.node_runs node ON node.workspace_id=attempt.workspace_id AND node.id=attempt.node_run_id
    JOIN app.workflow_runs run ON run.workspace_id=node.workspace_id AND run.id=node.workflow_run_id
    WHERE attempt.workspace_id=p_workspace AND attempt.id=p_attempt AND attempt.status='running'
      AND attempt.lease_owner=p_worker AND attempt.fence_token=p_fence AND attempt.lease_expires_at>clock_timestamp()
      AND attempt.dispatch_marked_at IS NOT NULL AND node.current_attempt_id=attempt.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'connection dispatch lease mismatch' USING ERRCODE='PTH02'; END IF;
  IF NOT EXISTS (
    WITH RECURSIVE published_nodes(value) AS (
      SELECT value FROM app.workflow_versions version,
        jsonb_array_elements(version.executable_json->'graph'->'nodes') value
        WHERE version.workspace_id=p_workspace AND version.id=v_version
      UNION ALL SELECT child FROM published_nodes parent,
        jsonb_array_elements(parent.value->'structured'->'body'->'nodes') child
    ) SELECT 1 FROM published_nodes WHERE value->>'id'=v_node
      AND value->'definition'->>'key'='slack.send_message' AND value->'definition'->>'version'='1'
      AND value->'connectionRefs'->>'slack_bot_token'=p_connection::text
  ) THEN RAISE EXCEPTION 'connection dispatch published binding mismatch' USING ERRCODE='PTH02'; END IF;
  SELECT * INTO v_existing FROM app.node_attempt_connection_dispatches WHERE workspace_id=p_workspace AND attempt_id=p_attempt;
  IF FOUND THEN
    IF v_existing.connection_id<>p_connection OR v_existing.secret_version_id<>p_secret
      OR v_existing.worker_id<>p_worker OR v_existing.fence_token<>p_fence THEN
      RAISE EXCEPTION 'connection dispatch identity is immutable' USING ERRCODE='PTH02';
    END IF;
    RETURN;
  END IF;
  INSERT INTO app.node_attempt_connection_dispatches(workspace_id,attempt_id,connection_id,provider_key,auth_type,secret_version_id,health_revision,worker_id,fence_token)
    VALUES(p_workspace,p_attempt,p_connection,'slack','slack_bot_token',p_secret,v_revision,p_worker,p_fence);
END $$;

CREATE FUNCTION app.record_node_attempt_connection_health(
  p_workspace uuid,p_attempt uuid,p_worker text,p_fence bigint,p_kind text,p_reason text,p_mode text,p_observation uuid,p_outbox uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace
    OR p_mode NOT IN ('observe','enforce') OR NOT EXISTS(
      SELECT 1 FROM app.node_attempts attempt JOIN app.node_attempt_connection_dispatches dispatch
        ON dispatch.workspace_id=attempt.workspace_id AND dispatch.attempt_id=attempt.id
      WHERE attempt.workspace_id=p_workspace AND attempt.id=p_attempt
        AND dispatch.worker_id=p_worker AND dispatch.fence_token=p_fence AND attempt.fence_token=p_fence
        AND attempt.status IN ('succeeded','failed','canceled','timed_out','outcome_unknown')) THEN
    RAISE EXCEPTION 'connection health lacks accepted dispatch completion' USING ERRCODE='PTH03';
  END IF;
  INSERT INTO app.connection_health_observations(id,workspace_id,attempt_id,kind,reason_code,production_mode,outbox_event_id)
    VALUES(p_observation,p_workspace,p_attempt,p_kind,p_reason,p_mode,p_outbox);
END $$;

CREATE FUNCTION app.apply_connection_health_observation(p_workspace uuid,p_observation uuid,p_mode text,p_outbox uuid,p_checksum text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE v_observation app.connection_health_observations%ROWTYPE;
  v_dispatch app.node_attempt_connection_dispatches%ROWTYPE; v_connection app.connections%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace
    OR p_mode NOT IN ('off','observe','enforce') THEN
    RAISE EXCEPTION 'connection health application tenant/mode mismatch' USING ERRCODE='PTH04';
  END IF;
  SELECT * INTO v_observation FROM app.connection_health_observations
    WHERE workspace_id=p_workspace AND id=p_observation FOR UPDATE;
  IF NOT FOUND OR v_observation.applied_at IS NOT NULL THEN RETURN false; END IF;
  IF v_observation.outbox_event_id<>p_outbox OR NOT EXISTS(
    SELECT 1 FROM app.outbox_events outbox JOIN app.inbox_receipts receipt
      ON receipt.workspace_id=outbox.workspace_id AND receipt.message_id=outbox.id
    WHERE outbox.workspace_id=p_workspace AND outbox.id=p_outbox
      AND outbox.job_name='apply-connection-health-observation' AND outbox.aggregate_type='connection-health-observation'
      AND outbox.aggregate_id=p_observation AND outbox.payload_checksum=p_checksum
      AND outbox.payload->>'workspaceId'=p_workspace::text AND outbox.payload->>'observationId'=p_observation::text
      AND outbox.payload->>'outboxEventId'=p_outbox::text AND outbox.schema_version=1
      AND receipt.consumer_name='connection-health-worker' AND receipt.payload_checksum=p_checksum AND receipt.completed_at IS NULL
  ) THEN RAISE EXCEPTION 'connection health authoritative delivery mismatch' USING ERRCODE='PTH04'; END IF;
  SELECT * INTO v_dispatch FROM app.node_attempt_connection_dispatches WHERE workspace_id=p_workspace AND attempt_id=v_observation.attempt_id;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE app.connection_health_observations SET applied_at=clock_timestamp() WHERE id=p_observation AND workspace_id=p_workspace;
  IF p_mode<>'enforce' OR v_observation.production_mode<>'enforce' THEN RETURN false; END IF;
  SELECT * INTO v_connection FROM app.connections WHERE workspace_id=p_workspace AND id=v_dispatch.connection_id FOR UPDATE;
  IF NOT FOUND OR v_connection.status='revoked' OR v_connection.current_secret_version_id<>v_dispatch.secret_version_id
    OR v_connection.health_revision<>v_dispatch.health_revision OR v_connection.provider_key<>'slack'
    OR v_connection.auth_type<>'slack_bot_token' THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.node_attempts WHERE workspace_id=p_workspace AND id=v_dispatch.attempt_id
      AND dispatch_marked_at IS NOT NULL AND status IN ('succeeded','failed','canceled','timed_out','outcome_unknown')) THEN RETURN false; END IF;
  PERFORM set_config('app.connection_health_protocol','1',true);
  IF v_observation.kind='healthy' THEN
    IF v_connection.status<>'active' THEN RETURN false; END IF;
    UPDATE app.connections SET last_healthy_at=greatest(last_healthy_at,v_observation.observed_at),last_run_observed_at=greatest(last_run_observed_at,v_observation.observed_at),
      last_error_code=NULL,updated_at=clock_timestamp() WHERE workspace_id=p_workspace AND id=v_connection.id;
  ELSE
    UPDATE app.connections SET status='reauthorization_required',health_revision=health_revision+1,
      last_error_code=v_observation.reason_code,last_run_observed_at=v_observation.observed_at,
      last_health_transition_at=clock_timestamp(),last_health_transition_source='run',updated_at=clock_timestamp()
      WHERE workspace_id=p_workspace AND id=v_connection.id;
    INSERT INTO app.connection_events(id,workspace_id,connection_id,event_type,actor_kind,actor_id,metadata)
      VALUES(p_observation,p_workspace,v_connection.id,'connection.reauthorization_required','worker','connection-health-worker',
        jsonb_build_object('source','run','status','reauthorization_required','reasonCode',v_observation.reason_code));
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION app.audit_connection_secret_access(p_workspace uuid,p_connection uuid,p_secret uuid,p_actor text,p_request text,p_trace text,p_purpose text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=on AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace
    OR p_actor IS NULL OR length(p_actor)>128 OR p_purpose IS NULL OR p_purpose !~ '^[a-z][a-z0-9._:-]{0,127}$'
    OR NOT EXISTS(SELECT 1 FROM app.connections WHERE workspace_id=p_workspace AND id=p_connection
      AND current_secret_version_id=p_secret AND status='active') THEN
    RAISE EXCEPTION 'credential access audit scope mismatch' USING ERRCODE='PTH05';
  END IF;
  INSERT INTO app.connection_events(id,workspace_id,connection_id,event_type,actor_kind,actor_id,request_id,trace_id,metadata)
    VALUES(gen_random_uuid(),p_workspace,p_connection,'connection.credential_accessed','worker',p_actor,p_request,p_trace,
      jsonb_build_object('purpose',p_purpose,'secretVersionId',p_secret));
END $$;

-- Delete only this attempt's health commands with its evidence. Delivered stale
-- messages are receipted by the bounded consumer without recreating evidence.
CREATE FUNCTION app.cleanup_connection_health_command() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=on AS $$
BEGIN
  DELETE FROM app.outbox_events WHERE workspace_id=OLD.workspace_id AND id=OLD.outbox_event_id
    AND job_name='apply-connection-health-observation';
  RETURN OLD;
END $$;
CREATE TRIGGER connection_health_observations_command_cleanup AFTER DELETE ON app.connection_health_observations
  FOR EACH ROW EXECUTE FUNCTION app.cleanup_connection_health_command();

DO $$
DECLARE v_definition text; v_marker text; v_matches integer;
BEGIN
  SELECT pg_get_functiondef('app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)'::regprocedure) INTO v_definition;
  v_marker:='''node_attempts''';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN RAISE EXCEPTION 'workspace tenant purge shape incompatible'; END IF;
  EXECUTE replace(v_definition,v_marker,'''connection_health_observations'', ''node_attempt_connection_dispatches'', '||v_marker);
END $$;

-- Existing deletion/recovery projection is workspace-first. Fence all retained
-- dispatches without pretending a workspace lifecycle action is a provider test.
DO $$
DECLARE v_definition text; v_marker text; v_matches integer;
BEGIN
  SELECT pg_get_functiondef('app.apply_workspace_deletion_side_effects()'::regprocedure) INTO v_definition;
  v_marker:='v_prior_workspace text;';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN RAISE EXCEPTION 'workspace deletion declaration shape incompatible'; END IF;
  v_definition:=replace(v_definition,v_marker,'v_prior_workspace text; v_prior_health_protocol text;');
  v_marker:='UPDATE app.connections SET status=''reauthorization_required'',';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN RAISE EXCEPTION 'workspace deletion connection effects shape incompatible'; END IF;
  v_definition:=replace(v_definition,v_marker,
    'v_prior_health_protocol:=current_setting(''app.connection_health_protocol'',true); PERFORM set_config(''app.connection_health_protocol'',''1'',true); '||v_marker||
    ' health_revision=health_revision+1,last_health_transition_at=NULL,last_health_transition_source=NULL,');
  v_marker:='WHERE workspace_id=NEW.id AND status=''active'';';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN RAISE EXCEPTION 'workspace deletion connection predicate shape incompatible'; END IF;
  v_definition:=replace(v_definition,v_marker,
    'WHERE workspace_id=NEW.id AND status=''active''; PERFORM set_config(''app.connection_health_protocol'',coalesce(v_prior_health_protocol,''''),true);');
  EXECUTE v_definition;
END $$;

-- The authoritative tenant purge already lists retention batches. Preserve
-- their ordinary mutation guard while admitting its existing leased delete
-- capability, as for immutable connection and workflow history.
DO $$
DECLARE v_definition text; v_marker text; v_matches integer;
BEGIN
  SELECT pg_get_functiondef('app.reject_retention_batch_direct_mutation()'::regprocedure) INTO v_definition;
  v_marker:='IF TG_OP = ''DELETE'' OR current_setting(''app.retention_batch_transition'', true) IS DISTINCT FROM ''on'' THEN';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN RAISE EXCEPTION 'retention batch mutation guard shape incompatible'; END IF;
  EXECUTE replace(v_definition,v_marker,
    'IF TG_OP=''DELETE'' AND app.workspace_purge_immutable_delete_is_armed(OLD.workspace_id) THEN RETURN OLD; END IF; '||v_marker);
END $$;

-- Read the current pointer under the lock, including after a concurrent rotation
-- commits. No serving caller gains connection UPDATE or arbitrary row locking.
CREATE FUNCTION app.lock_notification_connection(p_workspace uuid,p_connection uuid)
RETURNS TABLE(auth_type varchar,current_secret_version_id uuid,provider_key varchar,status varchar)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app SET row_security=on AS $$
  SELECT connection.auth_type,connection.current_secret_version_id,connection.provider_key,connection.status
  FROM app.connections connection
  WHERE connection.workspace_id=p_workspace AND connection.id=p_connection
    AND nullif(current_setting('app.workspace_id',true),'')::uuid=p_workspace
  FOR SHARE OF connection
$$;
ALTER FUNCTION app.lock_notification_connection(uuid,uuid) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.lock_notification_connection(uuid,uuid)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.lock_notification_connection(uuid,uuid) TO {{api_runtime_role}},{{worker_runtime_role}};

ALTER FUNCTION app.enforce_connection_health_protocol() OWNER TO {{owner_role}};
ALTER FUNCTION app.cleanup_connection_health_command() OWNER TO {{owner_role}};
ALTER FUNCTION app.bind_node_attempt_connection_dispatch(uuid,uuid,text,bigint,uuid,uuid) OWNER TO {{owner_role}};
ALTER FUNCTION app.record_node_attempt_connection_health(uuid,uuid,text,bigint,text,text,text,uuid,uuid) OWNER TO {{owner_role}};
ALTER FUNCTION app.apply_connection_health_observation(uuid,uuid,text,uuid,text) OWNER TO {{owner_role}};
ALTER FUNCTION app.audit_connection_secret_access(uuid,uuid,uuid,text,text,text,text) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.enforce_connection_health_protocol(),app.cleanup_connection_health_command(),
  app.bind_node_attempt_connection_dispatch(uuid,uuid,text,bigint,uuid,uuid),
  app.record_node_attempt_connection_health(uuid,uuid,text,bigint,text,text,text,uuid,uuid),
  app.apply_connection_health_observation(uuid,uuid,text,uuid,text),app.audit_connection_secret_access(uuid,uuid,uuid,text,text,text,text)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.bind_node_attempt_connection_dispatch(uuid,uuid,text,bigint,uuid,uuid),
  app.record_node_attempt_connection_health(uuid,uuid,text,bigint,text,text,text,uuid,uuid),
  app.apply_connection_health_observation(uuid,uuid,text,uuid,text),app.audit_connection_secret_access(uuid,uuid,uuid,text,text,text,text)
  TO {{worker_runtime_role}};
