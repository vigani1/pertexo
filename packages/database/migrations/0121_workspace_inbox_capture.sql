-- ADR 054 P1: inactive capture persistence only. No producer, queue registration,
-- worker composition or activation. Commands retain the tenant context and RLS.
CREATE FUNCTION app.workspace_inbox_source_checksum(
  p_workspace uuid,p_run uuid,p_sequence bigint,p_kind varchar,p_occurred timestamptz
) RETURNS character(64) LANGUAGE sql IMMUTABLE SECURITY INVOKER
SET search_path=pg_catalog AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object(
    'schemaVersion',1,'workspaceId',p_workspace,'runId',p_run,
    'terminalEventSequence',p_sequence::text,'kind',p_kind,
    'occurredAt',to_char(p_occurred AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  )::text,'UTF8')),'hex')::character(64);
$$;
REVOKE ALL ON FUNCTION app.workspace_inbox_source_checksum(uuid,uuid,bigint,varchar,timestamptz) FROM PUBLIC;

CREATE FUNCTION app.claim_workspace_inbox_capture(
  p_workspace uuid,p_source uuid,p_outbox uuid,p_checksum character(64),
  p_worker varchar,p_lease uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  v_source app.workspace_inbox_sources%ROWTYPE;
  v_outbox app.outbox_events%ROWTYPE;
  v_status varchar;
  v_payload jsonb;
  v_canonical text;
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
  SELECT * INTO v_outbox FROM app.outbox_events
    WHERE workspace_id=p_workspace AND id=p_outbox;
  IF v_outbox.id IS NULL THEN
    -- Valid-shape late delivery after BOTH evidence records are gone is only
    -- unavailable, not a verified delivery/receipt. Deleted bytes cannot be
    -- authenticated by this identifier-only interface. Never reconstruct them.
    SELECT * INTO v_source FROM app.workspace_inbox_sources
      WHERE workspace_id=p_workspace AND id=p_source FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('kind','unavailable'); END IF;
    RAISE EXCEPTION 'inbox delivery mismatch' USING ERRCODE='22023';
  END IF;
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

CREATE FUNCTION app.capture_workspace_inbox_audience(
  p_workspace uuid,p_source uuid,p_lease uuid,p_fence bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE v_source app.workspace_inbox_sources%ROWTYPE; v_status varchar; v_count bigint; v_completed_at timestamptz;
BEGIN
  IF p_workspace IS NULL OR p_source IS NULL OR p_lease IS NULL OR p_fence IS NULL OR p_fence<1
    OR p_workspace::text IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') THEN
    RAISE EXCEPTION 'invalid inbox capture scope' USING ERRCODE='22023';
  END IF;
  SELECT status INTO v_status FROM app.workspaces WHERE id=p_workspace FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','unavailable'); END IF;
  IF v_status<>'active' THEN RETURN jsonb_build_object('kind','inactive'); END IF;
  SELECT * INTO v_source FROM app.workspace_inbox_sources
    WHERE workspace_id=p_workspace AND id=p_source FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','unavailable'); END IF;
  IF v_source.expires_at<=clock_timestamp() OR v_source.status='expired' THEN RETURN jsonb_build_object('kind','expired'); END IF;
  IF v_source.captured_at IS NOT NULL THEN RETURN jsonb_build_object('kind','captured','audienceCount',v_source.audience_count::text); END IF;
  IF v_source.fence_token<>p_fence OR v_source.lease_token IS DISTINCT FROM p_lease
    OR v_source.lease_expires_at<=clock_timestamp() OR v_source.status<>'pending' THEN
    RETURN jsonb_build_object('kind','lost_ownership');
  END IF;
  IF v_source.checksum IS DISTINCT FROM app.workspace_inbox_source_checksum(
    p_workspace,v_source.run_id,v_source.terminal_event_sequence,v_source.kind,v_source.occurred_at) THEN
    RAISE EXCEPTION 'inbox source checksum mismatch' USING ERRCODE='22023';
  END IF;
  -- One untruncated INSERT statement snapshot. Finish the entire audience before
  -- checking fresh wall time; the marker and audience still commit atomically.
  WITH audience AS (
    INSERT INTO app.workspace_inbox_audience(workspace_id,source_id,user_id,observed_role_revision)
    SELECT p_workspace,p_source,membership.user_id,membership.role_revision
      FROM app.workspace_memberships membership JOIN app.users recipient ON recipient.id=membership.user_id
      WHERE membership.workspace_id=p_workspace AND membership.status='active'
        AND membership.role IN ('owner','admin','operator') AND recipient.status='active'
    RETURNING user_id
  ) SELECT count(*) INTO v_count FROM audience;
  v_completed_at:=clock_timestamp();
  IF v_completed_at>=v_source.expires_at THEN
    RAISE EXCEPTION 'inbox source expired during capture' USING ERRCODE='57014';
  END IF;
  UPDATE app.workspace_inbox_sources SET captured_at=v_completed_at,
    audience_count=v_count,status='captured',consecutive_attempts=0,
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE workspace_id=p_workspace AND id=p_source AND expires_at>v_completed_at;
  IF NOT FOUND THEN RAISE EXCEPTION 'inbox source expired during capture' USING ERRCODE='57014'; END IF;
  RETURN jsonb_build_object('kind','captured','audienceCount',v_count::text);
END $$;

CREATE FUNCTION app.fail_workspace_inbox_capture(
  p_workspace uuid,p_source uuid,p_lease uuid,p_fence bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE v_source app.workspace_inbox_sources%ROWTYPE; v_status varchar; v_delay double precision;
BEGIN
  IF p_workspace IS NULL OR p_source IS NULL OR p_lease IS NULL OR p_fence IS NULL OR p_fence<1
    OR p_workspace::text IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'') THEN
    RAISE EXCEPTION 'invalid inbox capture scope' USING ERRCODE='22023';
  END IF;
  SELECT status INTO v_status FROM app.workspaces WHERE id=p_workspace FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','unavailable'); END IF;
  IF v_status<>'active' THEN RETURN jsonb_build_object('kind','inactive'); END IF;
  SELECT * INTO v_source FROM app.workspace_inbox_sources WHERE workspace_id=p_workspace AND id=p_source FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','unavailable'); END IF;
  IF v_source.captured_at IS NOT NULL THEN RETURN jsonb_build_object('kind','captured','audienceCount',v_source.audience_count::text); END IF;
  IF v_source.fence_token<>p_fence OR v_source.lease_token IS DISTINCT FROM p_lease
    OR v_source.lease_expires_at<=clock_timestamp() OR v_source.status<>'pending' THEN RETURN jsonb_build_object('kind','lost_ownership'); END IF;
  v_delay:=least(300.0,5.0*power(2.0,greatest(0,v_source.consecutive_attempts-1)))*(0.5+random()*0.5);
  UPDATE app.workspace_inbox_sources SET
    status=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' WHEN consecutive_attempts>=10 THEN 'blocked' ELSE 'pending' END,
    next_attempt_at=clock_timestamp()+make_interval(secs=>v_delay),lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE workspace_id=p_workspace AND id=p_source RETURNING * INTO v_source;
  RETURN jsonb_build_object('kind',CASE WHEN v_source.status IN ('expired','blocked') THEN v_source.status ELSE 'retry_scheduled' END);
END $$;

ALTER FUNCTION app.workspace_inbox_source_checksum(uuid,uuid,bigint,varchar,timestamptz) OWNER TO {{owner_role}};
ALTER FUNCTION app.claim_workspace_inbox_capture(uuid,uuid,uuid,character,varchar,uuid) OWNER TO {{owner_role}};
ALTER FUNCTION app.capture_workspace_inbox_audience(uuid,uuid,uuid,bigint) OWNER TO {{owner_role}};
ALTER FUNCTION app.fail_workspace_inbox_capture(uuid,uuid,uuid,bigint) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.claim_workspace_inbox_capture(uuid,uuid,uuid,character,varchar,uuid),
  app.capture_workspace_inbox_audience(uuid,uuid,uuid,bigint),app.fail_workspace_inbox_capture(uuid,uuid,uuid,bigint)
  FROM PUBLIC,{{api_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.claim_workspace_inbox_capture(uuid,uuid,uuid,character,varchar,uuid),
  app.capture_workspace_inbox_audience(uuid,uuid,uuid,bigint),app.fail_workspace_inbox_capture(uuid,uuid,uuid,bigint)
  TO {{worker_runtime_role}};
