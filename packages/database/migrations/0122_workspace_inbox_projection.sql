-- ADR054 inactive P2. No producer, queue registration, worker wiring or activation.
-- Published migrations 0120/0121 remain immutable.
CREATE FUNCTION app.validate_workspace_inbox_delivery(
  p_workspace uuid,p_source uuid,p_outbox uuid,p_checksum character(64)
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE v_outbox app.outbox_events%ROWTYPE; v_payload jsonb; v_canonical text;
BEGIN
  IF p_workspace IS NULL OR p_source IS NULL OR p_outbox IS NULL
    OR p_checksum IS NULL OR p_checksum!~'^[0-9a-f]{64}$'
    OR p_workspace::text IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') THEN
    RAISE EXCEPTION 'invalid inbox delivery scope' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_outbox FROM app.outbox_events WHERE workspace_id=p_workspace AND id=p_outbox;
  IF NOT FOUND THEN RETURN false; END IF;
  v_payload:=jsonb_build_object('outboxEventId',p_outbox,'schemaVersion',1,
    'sourceId',p_source,'workspaceId',p_workspace);
  v_canonical:='{"outboxEventId":"'||p_outbox::text||'","schemaVersion":1,"sourceId":"'||p_source::text||'"';
  IF v_outbox.payload?'traceparent' THEN
    IF jsonb_typeof(v_outbox.payload->'traceparent')<>'string'
      OR (v_outbox.payload->>'traceparent')!~'^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'
      OR substring(v_outbox.payload->>'traceparent' FROM 4 FOR 32)=repeat('0',32)
      OR substring(v_outbox.payload->>'traceparent' FROM 37 FOR 16)=repeat('0',16) THEN
      RAISE EXCEPTION 'inbox delivery mismatch' USING ERRCODE='22023';
    END IF;
    v_payload:=v_payload||jsonb_build_object('traceparent',v_outbox.payload->>'traceparent');
    v_canonical:=v_canonical||',"traceparent":'||to_json(v_outbox.payload->>'traceparent')::text;
  END IF;
  v_canonical:=v_canonical||',"workspaceId":"'||p_workspace::text||'"}';
  IF v_outbox.id IS NULL OR v_outbox.aggregate_id IS DISTINCT FROM p_source
    OR v_outbox.aggregate_type IS DISTINCT FROM 'workspace-inbox-source'
    OR v_outbox.job_name IS DISTINCT FROM 'project-workspace-inbox'
    OR v_outbox.schema_version IS DISTINCT FROM 1 OR v_outbox.payload IS DISTINCT FROM v_payload
    OR v_outbox.payload_checksum IS DISTINCT FROM p_checksum
    OR encode(sha256(convert_to(v_canonical,'UTF8')),'hex') IS DISTINCT FROM p_checksum::text THEN
    RAISE EXCEPTION 'inbox delivery mismatch' USING ERRCODE='22023';
  END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION app.claim_workspace_inbox_capture(
  p_workspace uuid,p_source uuid,p_outbox uuid,p_checksum character(64),
  p_worker varchar,p_lease uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  v_source app.workspace_inbox_sources%ROWTYPE;
  v_status varchar;
  v_delay double precision;
BEGIN
  IF p_workspace IS NULL OR p_source IS NULL OR p_outbox IS NULL OR p_lease IS NULL
    OR p_checksum IS NULL OR p_checksum!~'^[0-9a-f]{64}$'
    OR p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 128
    OR p_workspace::text IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') THEN
    RAISE EXCEPTION 'invalid inbox capture scope' USING ERRCODE='22023';
  END IF;
  -- Shared lifecycle lock before feature locks: membership writers take the
  -- workspace first. Capture itself is a statement snapshot, not user locks.
  SELECT status INTO v_status FROM app.workspaces WHERE id=p_workspace FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','unavailable'); END IF;
  IF v_status<>'active' THEN RETURN jsonb_build_object('kind','inactive'); END IF;
  IF NOT app.validate_workspace_inbox_delivery(p_workspace,p_source,p_outbox,p_checksum) THEN
    -- Missing bytes cannot authenticate delivery. Retained source evidence
    -- still rejects a missing outbox; absent both is unavailable, never rebuilt.
    SELECT * INTO v_source FROM app.workspace_inbox_sources
      WHERE workspace_id=p_workspace AND id=p_source FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('kind','unavailable'); END IF;
    RAISE EXCEPTION 'inbox delivery mismatch' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_source FROM app.workspace_inbox_sources
    WHERE workspace_id=p_workspace AND id=p_source FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','unavailable'); END IF;
  IF v_source.checksum IS DISTINCT FROM app.workspace_inbox_source_checksum(
    p_workspace,v_source.run_id,v_source.terminal_event_sequence,v_source.kind,v_source.occurred_at) THEN
    RAISE EXCEPTION 'inbox source checksum mismatch' USING ERRCODE='22023';
  END IF;
  IF v_source.expires_at<=clock_timestamp() OR v_source.status='expired' THEN
    UPDATE app.workspace_inbox_sources SET status='expired',lease_owner=NULL,
      lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE workspace_id=p_workspace AND id=p_source;
    RETURN jsonb_build_object('kind','expired');
  END IF;
  IF v_source.captured_at IS NOT NULL THEN
    RETURN jsonb_build_object('kind','captured','audienceCount',v_source.audience_count::text);
  END IF;
  IF v_source.status='blocked' THEN RETURN jsonb_build_object('kind','blocked'); END IF;
  IF v_source.lease_expires_at>clock_timestamp() THEN RETURN jsonb_build_object('kind','busy'); END IF;
  -- Missing acknowledgments/accounting reconcile under the source lock after
  -- lease expiry. A late marker wins; otherwise account the previous acquisition
  -- once, before another claim. Expiry is not proof of rollback on its own.
  IF v_source.lease_token IS NOT NULL THEN
    v_delay:=least(300.0,5.0*power(2.0,greatest(0,v_source.consecutive_attempts-1)))*(0.5+random()*0.5);
    UPDATE app.workspace_inbox_sources SET
      status=CASE WHEN consecutive_attempts>=10 THEN 'blocked' ELSE 'pending' END,
      next_attempt_at=clock_timestamp()+make_interval(secs=>v_delay),
      lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE workspace_id=p_workspace AND id=p_source;
    RETURN jsonb_build_object('kind',CASE WHEN v_source.consecutive_attempts>=10 THEN 'blocked' ELSE 'retry_scheduled' END);
  END IF;
  IF v_source.consecutive_attempts>=10 THEN
    UPDATE app.workspace_inbox_sources SET status='blocked',updated_at=clock_timestamp()
      WHERE workspace_id=p_workspace AND id=p_source;
    RETURN jsonb_build_object('kind','blocked');
  END IF;
  IF v_source.next_attempt_at>clock_timestamp() THEN RETURN jsonb_build_object('kind','not_due'); END IF;
  UPDATE app.workspace_inbox_sources SET fence_token=fence_token+1,
    consecutive_attempts=consecutive_attempts+1,lease_owner=p_worker,
    lease_token=p_lease,lease_expires_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()
    WHERE workspace_id=p_workspace AND id=p_source
    RETURNING * INTO v_source;
  RETURN jsonb_build_object('kind','owned','fenceToken',v_source.fence_token::text);
END $$;

CREATE FUNCTION app.claim_workspace_inbox_projection(
  p_workspace uuid,p_source uuid,p_outbox uuid,p_checksum character(64),
  p_worker varchar,p_lease uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE v_source app.workspace_inbox_sources%ROWTYPE; v_status varchar; v_outbox_present boolean; v_delay double precision;
BEGIN
  IF p_workspace IS NULL OR p_source IS NULL OR p_outbox IS NULL OR p_lease IS NULL
    OR p_checksum IS NULL OR p_checksum!~'^[0-9a-f]{64}$'
    OR p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 128
    OR p_workspace::text IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') THEN
    RAISE EXCEPTION 'invalid inbox projection scope' USING ERRCODE='22023';
  END IF;
  SELECT status INTO v_status FROM app.workspaces WHERE id=p_workspace FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','unavailable'); END IF;
  IF v_status<>'active' THEN RETURN jsonb_build_object('kind','inactive'); END IF;
  v_outbox_present:=app.validate_workspace_inbox_delivery(p_workspace,p_source,p_outbox,p_checksum);
  SELECT * INTO v_source FROM app.workspace_inbox_sources WHERE workspace_id=p_workspace AND id=p_source FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','unavailable'); END IF;
  IF NOT v_outbox_present THEN RAISE EXCEPTION 'inbox delivery mismatch' USING ERRCODE='22023'; END IF;
  IF v_source.checksum IS DISTINCT FROM app.workspace_inbox_source_checksum(
    p_workspace,v_source.run_id,v_source.terminal_event_sequence,v_source.kind,v_source.occurred_at) THEN
    RAISE EXCEPTION 'inbox source checksum mismatch' USING ERRCODE='22023';
  END IF;
  IF v_source.expires_at<=clock_timestamp() OR v_source.status='expired' THEN
    UPDATE app.workspace_inbox_sources SET status='expired',lease_owner=NULL,lease_token=NULL,
      lease_expires_at=NULL,updated_at=clock_timestamp() WHERE workspace_id=p_workspace AND id=p_source;
    RETURN jsonb_build_object('kind','expired');
  END IF;
  IF v_source.captured_at IS NULL THEN RETURN jsonb_build_object('kind','not_captured'); END IF;
  IF v_source.status='completed' THEN RETURN jsonb_build_object('kind','completed'); END IF;
  IF v_source.status='blocked' THEN RETURN jsonb_build_object('kind','blocked'); END IF;
  IF v_source.lease_expires_at>clock_timestamp() THEN RETURN jsonb_build_object('kind','busy'); END IF;
  IF v_source.lease_token IS NOT NULL THEN
    v_delay:=least(300.0,5.0*power(2.0,greatest(0,v_source.consecutive_attempts-1)))*(0.5+random()*0.5);
    UPDATE app.workspace_inbox_sources SET status=CASE WHEN consecutive_attempts>=10 THEN 'blocked' ELSE 'captured' END,
      next_attempt_at=clock_timestamp()+make_interval(secs=>v_delay),lease_owner=NULL,lease_token=NULL,
      lease_expires_at=NULL,updated_at=clock_timestamp() WHERE workspace_id=p_workspace AND id=p_source;
    RETURN jsonb_build_object('kind',CASE WHEN v_source.consecutive_attempts>=10 THEN 'blocked' ELSE 'retry_scheduled' END);
  END IF;
  IF v_source.consecutive_attempts>=10 THEN
    UPDATE app.workspace_inbox_sources SET status='blocked',updated_at=clock_timestamp() WHERE workspace_id=p_workspace AND id=p_source;
    RETURN jsonb_build_object('kind','blocked');
  END IF;
  IF v_source.next_attempt_at>clock_timestamp() THEN RETURN jsonb_build_object('kind','not_due'); END IF;
  UPDATE app.workspace_inbox_sources SET fence_token=fence_token+1,consecutive_attempts=consecutive_attempts+1,
    lease_owner=p_worker,lease_token=p_lease,lease_expires_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()
    WHERE workspace_id=p_workspace AND id=p_source RETURNING * INTO v_source;
  RETURN jsonb_build_object('kind','owned','fenceToken',v_source.fence_token::text);
END $$;

CREATE FUNCTION app.project_workspace_inbox_page(
  p_workspace uuid,p_source uuid,p_lease uuid,p_fence bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  v_source app.workspace_inbox_sources%ROWTYPE;
  v_preview app.workspace_inbox_sources%ROWTYPE;
  v_status varchar;
  v_candidates uuid[];
  v_rechecked uuid[];
  v_eligible uuid[];
  v_user uuid;
  v_revision bigint;
  v_created timestamptz;
  v_finished timestamptz;
  v_inserted integer:=0;
  v_skipped integer:=0;
  v_more boolean;
BEGIN
  IF p_workspace IS NULL OR p_source IS NULL OR p_lease IS NULL OR p_fence IS NULL OR p_fence<1
    OR p_workspace::text IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') THEN
    RAISE EXCEPTION 'invalid inbox projection scope' USING ERRCODE='22023';
  END IF;
  SELECT status INTO v_status FROM app.workspaces WHERE id=p_workspace FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','unavailable'); END IF;
  IF v_status<>'active' THEN RETURN jsonb_build_object('kind','inactive'); END IF;
  -- Preview is NOT a feature row lock or an authorization decision.
  SELECT * INTO v_preview FROM app.workspace_inbox_sources WHERE workspace_id=p_workspace AND id=p_source;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','unavailable'); END IF;
  IF v_preview.fence_token<>p_fence OR v_preview.lease_token IS DISTINCT FROM p_lease
    OR v_preview.lease_expires_at<=clock_timestamp() OR v_preview.status<>'captured' THEN
    RETURN jsonb_build_object('kind','lost_ownership');
  END IF;
  SELECT coalesce(array_agg(page.user_id ORDER BY page.user_id),'{}'::uuid[]) INTO v_candidates FROM (
    SELECT user_id FROM app.workspace_inbox_audience WHERE workspace_id=p_workspace AND source_id=p_source
      AND status='pending' AND (v_preview.last_recipient_user_id IS NULL OR user_id>v_preview.last_recipient_user_id)
      ORDER BY user_id LIMIT 100
  ) page;
  -- Shared participants first, in identifier order; never add candidates after
  -- taking a source lock. Membership/user writers follow this same order.
  PERFORM id FROM app.users WHERE id=ANY(v_candidates) ORDER BY id FOR SHARE;
  PERFORM user_id FROM app.workspace_memberships WHERE workspace_id=p_workspace
    AND user_id=ANY(v_candidates) ORDER BY user_id FOR SHARE;
  SELECT * INTO v_source FROM app.workspace_inbox_sources WHERE workspace_id=p_workspace AND id=p_source FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','unavailable'); END IF;
  IF v_source.fence_token<>p_fence OR v_source.lease_token IS DISTINCT FROM p_lease
    OR v_source.lease_expires_at<=clock_timestamp() OR v_source.status<>'captured'
    OR v_source.last_recipient_user_id IS DISTINCT FROM v_preview.last_recipient_user_id THEN
    RETURN jsonb_build_object('kind','lost_ownership');
  END IF;
  IF v_source.checksum IS DISTINCT FROM app.workspace_inbox_source_checksum(
    p_workspace,v_source.run_id,v_source.terminal_event_sequence,v_source.kind,v_source.occurred_at) THEN
    RAISE EXCEPTION 'inbox source checksum mismatch' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(array_agg(page.user_id ORDER BY page.user_id),'{}'::uuid[]) INTO v_rechecked FROM (
    SELECT user_id FROM app.workspace_inbox_audience WHERE workspace_id=p_workspace AND source_id=p_source
      AND status='pending' AND (v_source.last_recipient_user_id IS NULL OR user_id>v_source.last_recipient_user_id)
      ORDER BY user_id LIMIT 100
  ) page;
  IF v_rechecked IS DISTINCT FROM v_candidates OR v_source.captured_at IS NULL
    OR EXISTS(SELECT 1 FROM app.workspace_inbox_audience WHERE workspace_id=p_workspace AND source_id=p_source
      AND status='pending' AND user_id<=v_source.last_recipient_user_id) THEN
    RAISE EXCEPTION 'inbox projection checkpoint mismatch' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(*) FROM app.users WHERE id=ANY(v_candidates))<>cardinality(v_candidates)
    OR (SELECT count(*) FROM app.workspace_memberships WHERE workspace_id=p_workspace AND user_id=ANY(v_candidates))<>cardinality(v_candidates) THEN
    RAISE EXCEPTION 'inbox projection participant mismatch' USING ERRCODE='22023';
  END IF;
  PERFORM user_id FROM app.workspace_inbox_audience WHERE workspace_id=p_workspace AND source_id=p_source
    AND user_id=ANY(v_candidates) ORDER BY user_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM app.workspace_inbox_entries WHERE workspace_id=p_workspace AND source_id=p_source AND user_id=ANY(v_candidates)) THEN
    RAISE EXCEPTION 'inbox projection decision mismatch' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(array_agg(membership.user_id ORDER BY membership.user_id),'{}'::uuid[]) INTO v_eligible
    FROM app.workspace_memberships membership JOIN app.users recipient ON recipient.id=membership.user_id
    WHERE membership.workspace_id=p_workspace AND membership.user_id=ANY(v_candidates)
      AND membership.status='active' AND membership.role IN ('owner','admin','operator') AND recipient.status='active';
  INSERT INTO app.workspace_inbox_recipient_state(workspace_id,user_id)
    SELECT p_workspace,recipient FROM unnest(v_eligible) recipient ORDER BY recipient
    ON CONFLICT(workspace_id,user_id) DO NOTHING;
  PERFORM user_id FROM app.workspace_inbox_recipient_state WHERE workspace_id=p_workspace AND user_id=ANY(v_eligible)
    ORDER BY user_id FOR UPDATE;
  FOREACH v_user IN ARRAY v_candidates LOOP
    v_created:=clock_timestamp();
    IF v_created>=v_source.expires_at OR v_created>=v_source.lease_expires_at THEN
      RAISE EXCEPTION 'inbox source or lease expired during projection' USING ERRCODE='57014';
    END IF;
    IF v_user=ANY(v_eligible) THEN
      UPDATE app.workspace_inbox_recipient_state SET revision=revision+1
        WHERE workspace_id=p_workspace AND user_id=v_user RETURNING revision INTO STRICT v_revision;
      INSERT INTO app.workspace_inbox_entries(id,workspace_id,source_id,user_id,creation_revision,created_at,expires_at)
        VALUES(gen_random_uuid(),p_workspace,p_source,v_user,v_revision,v_created,v_created+interval '720 hours');
      UPDATE app.workspace_inbox_audience SET status='inserted',processed_at=clock_timestamp()
        WHERE workspace_id=p_workspace AND source_id=p_source AND user_id=v_user;
      v_inserted:=v_inserted+1;
    ELSE
      UPDATE app.workspace_inbox_audience SET status='skipped',processed_at=clock_timestamp()
        WHERE workspace_id=p_workspace AND source_id=p_source AND user_id=v_user;
      v_skipped:=v_skipped+1;
    END IF;
  END LOOP;
  -- Check fresh time AFTER the complete page, including slow insert triggers.
  v_finished:=clock_timestamp();
  IF v_finished>=v_source.expires_at OR v_finished>=v_source.lease_expires_at THEN
    RAISE EXCEPTION 'inbox source or lease expired during projection' USING ERRCODE='57014';
  END IF;
  IF cardinality(v_candidates)>0 THEN v_source.last_recipient_user_id:=v_candidates[cardinality(v_candidates)]; END IF;
  v_more:=EXISTS(SELECT 1 FROM app.workspace_inbox_audience WHERE workspace_id=p_workspace AND source_id=p_source
    AND status='pending' AND (v_source.last_recipient_user_id IS NULL OR user_id>v_source.last_recipient_user_id));
  UPDATE app.workspace_inbox_sources SET last_recipient_user_id=v_source.last_recipient_user_id,
    status=CASE WHEN v_more THEN 'captured' ELSE 'completed' END,consecutive_attempts=0,
    next_attempt_at=v_finished,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=v_finished
    WHERE workspace_id=p_workspace AND id=p_source;
  RETURN jsonb_build_object('kind','projected','processedCount',cardinality(v_candidates),
    'insertedCount',v_inserted,'skippedCount',v_skipped,'hasMore',v_more);
END $$;

CREATE FUNCTION app.fail_workspace_inbox_projection(
  p_workspace uuid,p_source uuid,p_lease uuid,p_fence bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE v_source app.workspace_inbox_sources%ROWTYPE; v_status varchar; v_delay double precision;
BEGIN
  IF p_workspace IS NULL OR p_source IS NULL OR p_lease IS NULL OR p_fence IS NULL OR p_fence<1
    OR p_workspace::text IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') THEN
    RAISE EXCEPTION 'invalid inbox projection scope' USING ERRCODE='22023';
  END IF;
  SELECT status INTO v_status FROM app.workspaces WHERE id=p_workspace FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','unavailable'); END IF;
  IF v_status<>'active' THEN RETURN jsonb_build_object('kind','inactive'); END IF;
  SELECT * INTO v_source FROM app.workspace_inbox_sources WHERE workspace_id=p_workspace AND id=p_source FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','unavailable'); END IF;
  IF v_source.status='completed' THEN RETURN jsonb_build_object('kind','completed'); END IF;
  IF v_source.fence_token<>p_fence OR v_source.lease_token IS DISTINCT FROM p_lease
    OR v_source.lease_expires_at<=clock_timestamp() OR v_source.status<>'captured' THEN
    RETURN jsonb_build_object('kind','lost_ownership');
  END IF;
  v_delay:=least(300.0,5.0*power(2.0,greatest(0,v_source.consecutive_attempts-1)))*(0.5+random()*0.5);
  UPDATE app.workspace_inbox_sources SET
    status=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' WHEN consecutive_attempts>=10 THEN 'blocked' ELSE 'captured' END,
    next_attempt_at=clock_timestamp()+make_interval(secs=>v_delay),lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE workspace_id=p_workspace AND id=p_source RETURNING * INTO v_source;
  RETURN jsonb_build_object('kind',CASE WHEN v_source.status IN ('expired','blocked') THEN v_source.status ELSE 'retry_scheduled' END);
END $$;

ALTER FUNCTION app.validate_workspace_inbox_delivery(uuid,uuid,uuid,character) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.validate_workspace_inbox_delivery(uuid,uuid,uuid,character)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
ALTER FUNCTION app.claim_workspace_inbox_capture(uuid,uuid,uuid,character,varchar,uuid) OWNER TO {{owner_role}};
ALTER FUNCTION app.claim_workspace_inbox_projection(uuid,uuid,uuid,character,varchar,uuid) OWNER TO {{owner_role}};
ALTER FUNCTION app.project_workspace_inbox_page(uuid,uuid,uuid,bigint) OWNER TO {{owner_role}};
ALTER FUNCTION app.fail_workspace_inbox_projection(uuid,uuid,uuid,bigint) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.claim_workspace_inbox_projection(uuid,uuid,uuid,character,varchar,uuid),
  app.project_workspace_inbox_page(uuid,uuid,uuid,bigint),app.fail_workspace_inbox_projection(uuid,uuid,uuid,bigint)
  FROM PUBLIC,{{api_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.claim_workspace_inbox_projection(uuid,uuid,uuid,character,varchar,uuid),
  app.project_workspace_inbox_page(uuid,uuid,uuid,bigint),app.fail_workspace_inbox_projection(uuid,uuid,uuid,bigint)
  TO {{worker_runtime_role}};
-- No raw worker progress/decision/revision writes may bypass owned commands.
REVOKE INSERT ON app.workspace_inbox_audience,app.workspace_inbox_recipient_state,app.workspace_inbox_entries FROM {{worker_runtime_role}};
REVOKE UPDATE(status,processed_at) ON app.workspace_inbox_audience FROM {{worker_runtime_role}};
REVOKE UPDATE(revision) ON app.workspace_inbox_recipient_state FROM {{worker_runtime_role}};
REVOKE UPDATE(status,captured_at,audience_count,last_recipient_user_id,consecutive_attempts,next_attempt_at,
  fence_token,lease_owner,lease_token,lease_expires_at,updated_at) ON app.workspace_inbox_sources FROM {{worker_runtime_role}};
