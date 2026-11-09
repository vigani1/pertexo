--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: app; Type: SCHEMA; Schema: -; Owner: pertexo_owner
--

CREATE SCHEMA app;


ALTER SCHEMA app OWNER TO pertexo_owner;

--
-- Name: pertexo_internal; Type: SCHEMA; Schema: -; Owner: pertexo_owner
--

CREATE SCHEMA pertexo_internal;


ALTER SCHEMA pertexo_internal OWNER TO pertexo_owner;

--
-- Name: apply_instance_capacity(integer, integer, integer); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.apply_instance_capacity(p_active_run_limit integer, p_queued_run_limit integer, p_artifact_count_limit integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE
  current_limits app.instance_capacity%ROWTYPE;
  prior_workspace text;
  workspace uuid;
BEGIN
  SELECT * INTO current_limits FROM app.instance_capacity FOR UPDATE;
  IF current_limits.active_run_limit=p_active_run_limit
     AND current_limits.queued_run_limit=p_queued_run_limit
     AND current_limits.artifact_count_limit=p_artifact_count_limit THEN
    RETURN;
  END IF;
  UPDATE app.instance_capacity SET active_run_limit=p_active_run_limit,
    queued_run_limit=p_queued_run_limit,artifact_count_limit=p_artifact_count_limit,
    updated_at=clock_timestamp();
  UPDATE app.workspace_artifact_capacity SET artifact_count_limit=p_artifact_count_limit,
    updated_at=clock_timestamp();
  prior_workspace := current_setting('app.workspace_id',true);
  FOR workspace IN SELECT id FROM app.workspaces LOOP
    PERFORM set_config('app.workspace_id',workspace::text,true);
    UPDATE app.workspace_execution_entitlement_versions
       SET active_run_limit=p_active_run_limit,queued_run_limit=p_queued_run_limit
     WHERE workspace_id=workspace;
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
END $$;


ALTER FUNCTION app.apply_instance_capacity(p_active_run_limit integer, p_queued_run_limit integer, p_artifact_count_limit integer) OWNER TO pertexo_owner;

--
-- Name: arm_dispatcher_workflow_run_active_admission(uuid, uuid); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.arm_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  UPDATE app.workflow_run_active_admissions
     SET recover_after=clock_timestamp()+interval '5 minutes'
   WHERE workspace_id=p_workspace_id AND outbox_event_id=p_outbox_event_id;
  RETURN FOUND;
END $$;


ALTER FUNCTION app.arm_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) OWNER TO pertexo_owner;

--
-- Name: artifact_capacity_purge_start(); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.artifact_capacity_purge_start() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF NEW.status='purging' AND OLD.status IS DISTINCT FROM 'purging'
    AND NOT EXISTS (
      SELECT 1 FROM app.artifacts artifact
       WHERE artifact.workspace_id=NEW.id AND artifact.status<>'deleted'
    ) THEN
    DELETE FROM app.workspace_artifact_capacity
     WHERE workspace_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION app.artifact_capacity_purge_start() OWNER TO pertexo_owner;

--
-- Name: artifact_capacity_transition(); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.artifact_capacity_transition() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE
  v_workspace_id uuid:=coalesce(NEW.workspace_id,OLD.workspace_id);
  v_context text:=nullif(current_setting('app.workspace_id',true),'');
  v_capacity app.workspace_artifact_capacity%ROWTYPE;
  v_purge boolean:=false;
  v_release boolean:=false;
BEGIN
  -- A purging workspace releases its artifacts without a tenant context.
  v_purge:=EXISTS(SELECT 1 FROM app.workspaces
    WHERE id=v_workspace_id AND status='purging');
  IF v_workspace_id IS NULL OR (NOT v_purge AND v_context IS NULL)
    OR (NOT v_purge AND v_context<>v_workspace_id::text) THEN
    RAISE EXCEPTION 'artifact capacity tenant context is required'
      USING ERRCODE='42501';
  END IF;

  IF TG_OP='UPDATE' THEN
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.byte_length IS DISTINCT FROM OLD.byte_length
      OR NEW.purpose IS DISTINCT FROM OLD.purpose
      OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
      OR NEW.media_type IS DISTINCT FROM OLD.media_type
      OR NEW.sha256 IS DISTINCT FROM OLD.sha256
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'artifact immutable metadata cannot change'
        USING ERRCODE='P0002', DETAIL='artifact_metadata_immutable';
    END IF;
    IF OLD.status='deleted' AND NEW.status<>'deleted' THEN
      RAISE EXCEPTION 'deleted artifact cannot be revived'
        USING ERRCODE='P0003', DETAIL='artifact_lifecycle_conflict';
    END IF;
    IF NEW.status='deleted' AND OLD.status<>'deleted' THEN
      IF OLD.status<>'deleting' AND NOT v_purge THEN
        RAISE EXCEPTION 'artifact must be deleting before metadata deletion'
          USING ERRCODE='P0003', DETAIL='artifact_lifecycle_conflict';
      END IF;
      v_release:=true;
    END IF;
  ELSIF TG_OP='INSERT' THEN
    IF NEW.status='deleted' THEN
      RAISE EXCEPTION 'artifact cannot be created as deleted'
        USING ERRCODE='P0003', DETAIL='artifact_lifecycle_conflict';
    END IF;
  ELSIF TG_OP='DELETE' THEN
    IF OLD.status NOT IN ('deleting','deleted') AND NOT v_purge THEN
      RAISE EXCEPTION 'artifact deletion requires completed physical removal'
        USING ERRCODE='P0003', DETAIL='artifact_lifecycle_conflict';
    END IF;
    v_release:=OLD.status<>'deleted';
  END IF;

  INSERT INTO app.workspace_artifact_capacity(workspace_id)
  VALUES(v_workspace_id) ON CONFLICT (workspace_id) DO NOTHING;
  SELECT * INTO v_capacity
    FROM app.workspace_artifact_capacity
   WHERE workspace_id=v_workspace_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'artifact capacity record is unavailable'
      USING ERRCODE='P0004', DETAIL='artifact_capacity_unavailable';
  END IF;

  IF TG_OP='INSERT' THEN
    IF v_capacity.charged_count+1>v_capacity.artifact_count_limit
      OR v_capacity.charged_bytes+NEW.byte_length>v_capacity.byte_limit THEN
      RAISE EXCEPTION 'workspace artifact capacity exceeded'
        USING ERRCODE='P0001', DETAIL='artifact_capacity_exceeded';
    END IF;
    UPDATE app.workspace_artifact_capacity
       SET charged_bytes=charged_bytes+NEW.byte_length,
           charged_count=charged_count+1,updated_at=clock_timestamp()
     WHERE workspace_id=v_workspace_id;
  ELSIF v_release THEN
    IF v_capacity.charged_count<1
      OR v_capacity.charged_bytes<OLD.byte_length THEN
      RAISE EXCEPTION 'artifact capacity charge underflow'
        USING ERRCODE='P0004', DETAIL='artifact_capacity_underflow';
    END IF;
    UPDATE app.workspace_artifact_capacity
       SET charged_bytes=charged_bytes-OLD.byte_length,
           charged_count=charged_count-1,updated_at=clock_timestamp()
     WHERE workspace_id=v_workspace_id;
  END IF;

  -- The tenant-row purge function predates this table and fail-closes on
  -- residual workspace-owned relations. Remove an empty capacity row as soon
  -- as the last charged artifact is dismantled under its fenced purge token.
  IF v_purge AND TG_OP IN ('DELETE','UPDATE')
    AND NOT EXISTS (
      SELECT 1 FROM app.artifacts artifact
       WHERE artifact.workspace_id=v_workspace_id
         AND artifact.id<>coalesce(OLD.id,NEW.id)
         AND artifact.status<>'deleted'
    ) THEN
    DELETE FROM app.workspace_artifact_capacity
     WHERE workspace_id=v_workspace_id;
  END IF;

  RETURN case when TG_OP='DELETE' then OLD else NEW end;
END;
$$;


ALTER FUNCTION app.artifact_capacity_transition() OWNER TO pertexo_owner;

--
-- Name: artifact_owner_ids(jsonb, text); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.artifact_owner_ids(p_value jsonb, p_format text) RETURNS SETOF uuid
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    AS $_$
DECLARE v_value jsonb:=p_value; v_format text:=p_format;
BEGIN
  IF right(v_format,5)='-text' THEN
    -- Index maintenance is not a second stored-document validator.
    BEGIN v_value:=(p_value #>> '{}')::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN RETURN;
    END;
    v_format:=left(v_format,length(v_format)-5);
  END IF;
  IF v_format='authored' THEN
    RETURN QUERY SELECT DISTINCT (reference #>> '{}')::uuid
      FROM jsonb_path_query(v_value,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId) && exists(@.byteLength) && exists(@.mediaType) && exists(@.sha256)).artifactId'::jsonpath) reference
      WHERE jsonb_typeof(reference)='string'
        AND reference #>> '{}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  ELSE
    RETURN QUERY SELECT * FROM app.execution_artifact_ids(v_value,v_format);
  END IF;
END $_$;


ALTER FUNCTION app.artifact_owner_ids(p_value jsonb, p_format text) OWNER TO pertexo_owner;

--
-- Name: FUNCTION artifact_owner_ids(p_value jsonb, p_format text); Type: COMMENT; Schema: app; Owner: pertexo_owner
--

COMMENT ON FUNCTION app.artifact_owner_ids(p_value jsonb, p_format text) IS 'Derived storage: authored descriptors use the shared SDK descriptor shape; execution values use the existing batch-C extractor. No visibility, admission, expiry or retention policy.';


--
-- Name: artifact_owner_text_may_reference(text); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.artifact_owner_text_may_reference(p_value text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    AS $_$
BEGIN
  RETURN jsonb_path_exists(p_value::jsonb,'lax $.** ? (@.kind.type() == "string" && @.kind == "artifact" && exists(@.artifactId))'::jsonpath);
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $_$;


ALTER FUNCTION app.artifact_owner_text_may_reference(p_value text) OWNER TO pertexo_owner;

--
-- Name: FUNCTION artifact_owner_text_may_reference(p_value text); Type: COMMENT; Schema: app; Owner: pertexo_owner
--

COMMENT ON FUNCTION app.artifact_owner_text_may_reference(p_value text) IS 'Derived storage precheck for text-backed owner JSON; malformed stored documents cannot contain an extractable descriptor.';


--
-- Name: check_execution_value_bytes(); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.check_execution_value_bytes() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $_$
DECLARE value_bytes integer;
BEGIN
  EXECUTE format('SELECT octet_length(($1).%I::text)', TG_ARGV[0])
    INTO value_bytes USING NEW;
  IF value_bytes > TG_ARGV[1]::integer THEN
    RAISE EXCEPTION 'execution value exceeds stored byte limit'
      USING ERRCODE='23514', CONSTRAINT=TG_ARGV[2],
        TABLE=TG_TABLE_NAME, SCHEMA=TG_TABLE_SCHEMA;
  END IF;
  RETURN NEW;
END $_$;


ALTER FUNCTION app.check_execution_value_bytes() OWNER TO pertexo_owner;

--
-- Name: claim_due_node_run_wakeups(integer); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.claim_due_node_run_wakeups(p_limit integer) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  claimed_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'due node wakeup limit must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  WITH due AS MATERIALIZED (
    SELECT node.id, node.workspace_id, node.workflow_run_id,
           coalesce(node.retry_due_at, node.resume_at) AS due_at
      FROM app.node_runs node
     WHERE node.status = 'waiting'
       AND coalesce(node.retry_due_at, node.resume_at) <= clock_timestamp()
       AND node.due_wakeup_at IS DISTINCT FROM
           coalesce(node.retry_due_at, node.resume_at)
     ORDER BY coalesce(node.retry_due_at, node.resume_at), node.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  ), marked AS (
    UPDATE app.node_runs node
       SET due_wakeup_at = due.due_at,
           updated_at = clock_timestamp()
      FROM due
     WHERE node.id = due.id
     RETURNING node.workspace_id, node.workflow_run_id
  ), events AS (
    SELECT marked.workspace_id, marked.workflow_run_id,
           gen_random_uuid() AS outbox_event_id
      FROM marked
  )
  INSERT INTO app.outbox_events (
    id, workspace_id, job_name, aggregate_type,
    aggregate_id, payload, payload_checksum
  )
  SELECT event.outbox_event_id, event.workspace_id, 'advance-workflow-run',
         'workflow-run', event.workflow_run_id,
         jsonb_build_object(
           'outboxEventId', event.outbox_event_id,
           'runId', event.workflow_run_id,
           'workspaceId', event.workspace_id
         ),
         encode(sha256(convert_to(
           '{"outboxEventId":"' || event.outbox_event_id::text ||
           '","runId":"' || event.workflow_run_id::text ||
           '","workspaceId":"' || event.workspace_id::text || '"}',
           'UTF8'
         )), 'hex')
    FROM events event;

  GET DIAGNOSTICS claimed_count = ROW_COUNT;
  RETURN claimed_count;
END;
$$;


ALTER FUNCTION app.claim_due_node_run_wakeups(p_limit integer) OWNER TO pertexo_owner;

--
-- Name: claim_due_run_failure_notification_recoveries(integer); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.claim_due_run_failure_notification_recoveries(p_limit integer) RETURNS TABLE(id uuid, workspace_id uuid, status character varying, delivery_attempts integer, side_effect_class character varying, possibly_dispatched boolean)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid failure notification claim bound' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
    SELECT intent.id,intent.workspace_id,intent.status,intent.delivery_attempts,intent.side_effect_class,intent.possibly_dispatched
      FROM app.run_failure_notification_intents intent
      WHERE intent.status IN ('claimed','dispatching') AND intent.recovery_at<=clock_timestamp()
      ORDER BY intent.recovery_at,intent.id LIMIT p_limit FOR UPDATE OF intent SKIP LOCKED;
END $$;


ALTER FUNCTION app.claim_due_run_failure_notification_recoveries(p_limit integer) OWNER TO pertexo_owner;

--
-- Name: claim_due_trigger_schedules(character varying, integer, integer); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.claim_due_trigger_schedules(p_lease_owner character varying, p_limit integer, p_lease_seconds integer) RETURNS TABLE(trigger_id uuid, workspace_id uuid, workflow_id uuid, workflow_version_id uuid, node_id character varying, recurrence_kind character varying, cron_expression character varying, timezone character varying, interval_minutes integer, misfire_policy character varying, config_fingerprint character varying, anchor_at timestamp with time zone, next_fire_at timestamp with time zone, lease_token uuid, observed_at timestamp with time zone)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_observed_at timestamptz := clock_timestamp();
BEGIN
  IF p_lease_owner IS NULL OR length(p_lease_owner)<1 OR length(p_lease_owner)>128
    OR p_limit IS NULL OR p_limit<1 OR p_limit>100
    OR p_lease_seconds IS NULL OR p_lease_seconds<1 OR p_lease_seconds>300 THEN
    RAISE EXCEPTION 'invalid schedule claim bounds' USING ERRCODE='22023';
  END IF;
  RETURN QUERY WITH ranked AS (
    SELECT schedule.trigger_id,row_number() over (partition by schedule.workspace_id
      ORDER BY schedule.next_fire_at,schedule.trigger_id) AS workspace_rank
      FROM app.trigger_schedules schedule
      JOIN app.workflow_triggers trigger ON trigger.id=schedule.trigger_id
     WHERE schedule.status='enabled' AND schedule.next_fire_at<=v_observed_at
       AND (schedule.admission_deferred_until IS NULL OR schedule.admission_deferred_until<=v_observed_at)
       AND (schedule.lease_expires_at IS NULL OR schedule.lease_expires_at<=v_observed_at)
       AND trigger.status='active'
  ), due AS (
    SELECT schedule.trigger_id FROM app.trigger_schedules schedule
      JOIN ranked ON ranked.trigger_id=schedule.trigger_id AND ranked.workspace_rank=1
      JOIN app.workflow_triggers trigger ON trigger.id=schedule.trigger_id
     WHERE schedule.status='enabled' AND schedule.next_fire_at<=v_observed_at
       AND (schedule.admission_deferred_until IS NULL OR schedule.admission_deferred_until<=v_observed_at)
       AND (schedule.lease_expires_at IS NULL OR schedule.lease_expires_at<=v_observed_at)
       AND trigger.status='active'
     ORDER BY schedule.next_fire_at,schedule.workspace_id,schedule.trigger_id
     LIMIT p_limit FOR UPDATE OF schedule SKIP LOCKED
  ), claimed AS (
    UPDATE app.trigger_schedules schedule SET lease_owner=p_lease_owner,
      lease_token=gen_random_uuid(),lease_acquired_at=v_observed_at,
      lease_expires_at=v_observed_at+make_interval(secs=>p_lease_seconds),updated_at=v_observed_at
      FROM due WHERE schedule.trigger_id=due.trigger_id RETURNING schedule.*
  ) SELECT claimed.trigger_id,claimed.workspace_id,trigger.workflow_id,trigger.workflow_version_id,
      trigger.node_id,claimed.recurrence_kind,claimed.cron_expression,claimed.timezone,
      claimed.interval_minutes,claimed.misfire_policy,claimed.config_fingerprint,claimed.anchor_at,
      claimed.next_fire_at,claimed.lease_token,v_observed_at
    FROM claimed JOIN app.workflow_triggers trigger ON trigger.id=claimed.trigger_id
    ORDER BY claimed.next_fire_at,claimed.workspace_id,claimed.trigger_id;
END $$;


ALTER FUNCTION app.claim_due_trigger_schedules(p_lease_owner character varying, p_limit integer, p_lease_seconds integer) OWNER TO pertexo_owner;

--
-- Name: claim_due_workflow_run_deadlines(integer); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.claim_due_workflow_run_deadlines(p_limit integer) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE claimed_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'due workflow deadline limit must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  WITH due AS MATERIALIZED (
    SELECT run.id, run.workspace_id, run.deadline_at
      FROM app.workflow_runs run
     WHERE run.status IN ('queued', 'running', 'waiting')
       AND run.deadline_at <= clock_timestamp()
       AND run.deadline_wakeup_at IS DISTINCT FROM run.deadline_at
     ORDER BY run.deadline_at, run.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  ), marked AS (
    UPDATE app.workflow_runs run
       SET deadline_wakeup_at = due.deadline_at,
           updated_at = clock_timestamp()
      FROM due WHERE run.id = due.id
    RETURNING run.id, run.workspace_id
  ), events AS (
    SELECT marked.*, gen_random_uuid() AS outbox_event_id FROM marked
  )
  INSERT INTO app.outbox_events (
    id, workspace_id, job_name, aggregate_type,
    aggregate_id, payload, payload_checksum
  )
  SELECT outbox_event_id, workspace_id, 'advance-workflow-run',
         'workflow-run', id,
         jsonb_build_object('outboxEventId', outbox_event_id, 'runId', id,
           'workspaceId', workspace_id),
         encode(sha256(convert_to(
           '{"outboxEventId":"' || outbox_event_id::text ||
           '","runId":"' || id::text ||
           '","workspaceId":"' || workspace_id::text || '"}',
           'UTF8')), 'hex')
    FROM events;
  GET DIAGNOSTICS claimed_count = ROW_COUNT;
  RETURN claimed_count;
END;
$$;


ALTER FUNCTION app.claim_due_workflow_run_deadlines(p_limit integer) OWNER TO pertexo_owner;

--
-- Name: claim_workspace_inbox_events(integer); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.claim_workspace_inbox_events(p_limit integer) RETURNS TABLE(id uuid, workspace_id uuid, workflow_id uuid, run_id uuid, kind character varying, occurred_at text, workspace_status character varying)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF NULLIF(current_setting('app.actor_id',true),'') IS NOT NULL THEN
    RAISE EXCEPTION 'inbox queue claim requires a worker' USING ERRCODE='42501';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'inbox fold limit must be between 1 and 1000' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
    SELECT event.id,event.workspace_id,event.workflow_id,event.run_id,event.kind,
      to_char(event.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),workspace.status
    FROM app.workspace_inbox_events event
    JOIN app.workspaces workspace ON workspace.id=event.workspace_id
    ORDER BY event.created_at,event.id LIMIT p_limit FOR UPDATE OF event SKIP LOCKED;
END $$;


ALTER FUNCTION app.claim_workspace_inbox_events(p_limit integer) OWNER TO pertexo_owner;

--
-- Name: FUNCTION claim_workspace_inbox_events(p_limit integer); Type: COMMENT; Schema: app; Owner: pertexo_owner
--

COMMENT ON FUNCTION app.claim_workspace_inbox_events(p_limit integer) IS 'Queue claiming only; the caller retains row locks until scoped thread writes and consumption commit.';


--
-- Name: delete_removed_member_private_rows(uuid, uuid[], regclass); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.delete_removed_member_private_rows(p_workspace_id uuid, p_user_ids uuid[], p_table regclass) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $_$
DECLARE v_members integer; v_deleted integer;
BEGIN
  IF p_workspace_id IS NULL OR p_workspace_id::text IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'')
     OR p_table IS NULL OR p_table NOT IN ('app.notice_preferences'::regclass,'app.notice_subscriptions'::regclass,'app.workspace_inbox_reads'::regclass)
  THEN RAISE EXCEPTION 'removed membership storage scope required' USING ERRCODE='42501'; END IF;
  IF p_user_ids IS NULL OR cardinality(p_user_ids)=0 THEN RETURN 0; END IF;
  -- Fence reactivation until the caller's transaction finishes deleting private rows.
  PERFORM user_id FROM app.workspace_memberships
    WHERE workspace_id=p_workspace_id AND user_id=ANY(p_user_ids) AND status='removed'
    ORDER BY user_id FOR SHARE;
  GET DIAGNOSTICS v_members = ROW_COUNT;
  IF v_members<>cardinality(p_user_ids) THEN
    RAISE EXCEPTION 'removed membership required' USING ERRCODE='42501';
  END IF;
  EXECUTE format('DELETE FROM %s WHERE workspace_id=$1 AND user_id=ANY($2)',p_table)
    USING p_workspace_id,p_user_ids;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $_$;


ALTER FUNCTION app.delete_removed_member_private_rows(p_workspace_id uuid, p_user_ids uuid[], p_table regclass) OWNER TO pertexo_owner;

--
-- Name: FUNCTION delete_removed_member_private_rows(p_workspace_id uuid, p_user_ids uuid[], p_table regclass); Type: COMMENT; Schema: app; Owner: pertexo_owner
--

COMMENT ON FUNCTION app.delete_removed_member_private_rows(p_workspace_id uuid, p_user_ids uuid[], p_table regclass) IS 'Storage capability: delete only the named private table rows for scoped, locked removed memberships. Core owns cleanup selection; personal-row read policies are unchanged.';


--
-- Name: discover_due_coordinated_events(integer); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.discover_due_coordinated_events(p_limit integer) RETURNS TABLE(workspace_id uuid, event_id uuid)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    SET row_security TO 'on'
    AS $$
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN
   RAISE EXCEPTION 'Invalid coordination discovery limit' USING ERRCODE='22023';
 END IF;
 RETURN QUERY
 WITH heads AS MATERIALIZED (
   SELECT DISTINCT ON (event.key_id) event.workspace_id,event.id,event.due_at
   FROM app.trigger_coordinated_events event
   WHERE event.status='pending'
   ORDER BY event.key_id,event.received_at,event.id
 ), due AS (
   SELECT head.workspace_id,head.id,head.due_at,
     row_number() OVER (PARTITION BY head.workspace_id ORDER BY head.due_at,head.id) workspace_rank
   FROM heads head WHERE head.due_at<=clock_timestamp()
 ) SELECT due.workspace_id,due.id FROM due ORDER BY due.workspace_rank,due.due_at,due.id LIMIT p_limit;
END;
$$;


ALTER FUNCTION app.discover_due_coordinated_events(p_limit integer) OWNER TO pertexo_owner;

--
-- Name: enforce_workflow_run_admission(); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.enforce_workflow_run_admission() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE
  entitlement record;
  actual_queued integer;
  actual_active integer;
  reserved_active integer;
  next_queued integer;
  next_active integer;
BEGIN
  IF TG_OP='UPDATE' AND NEW.admission_ticket IS DISTINCT FROM OLD.admission_ticket THEN
    RAISE EXCEPTION 'admission ticket is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' AND NEW.status IN ('running','waiting')
     AND EXISTS(SELECT 1 FROM app.workflow_concurrency_policies WHERE workspace_id=NEW.workspace_id
       AND workflow_id=NEW.workflow_id AND active_run_limit IS NOT NULL) THEN
    IF current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
    END IF;
    RAISE EXCEPTION 'capped production runs must enter the durable queue' USING ERRCODE='PTC02';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='queued' AND NEW.status IN ('running','waiting')
     AND EXISTS(SELECT 1 FROM app.workflow_concurrency_policies WHERE workspace_id=NEW.workspace_id
       AND workflow_id=NEW.workflow_id AND active_run_limit IS NOT NULL)
     AND current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
  END IF;
  PERFORM 1 FROM app.workspaces WHERE id=NEW.workspace_id FOR SHARE;
  IF TG_OP='INSERT' THEN
    SELECT version.version,version.active_run_limit,version.queued_run_limit
      INTO entitlement
      FROM app.workspace_execution_entitlements current
      JOIN app.workspace_execution_entitlement_versions version
        ON version.workspace_id=current.workspace_id
       AND version.version=current.current_version
     WHERE current.workspace_id=NEW.workspace_id
     FOR SHARE OF current,version;
  ELSE
    SELECT version.version,version.active_run_limit,version.queued_run_limit
      INTO entitlement
      FROM app.workspace_execution_entitlement_versions version
     WHERE version.workspace_id=OLD.workspace_id
       AND version.version=OLD.execution_entitlement_version
     FOR SHARE OF version;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace.run_admission_denied' USING ERRCODE='PTA01';
  END IF;
  PERFORM 1 FROM app.workspace_execution_admission_counters
   WHERE workspace_id=NEW.workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace.run_admission_denied' USING ERRCODE='PTA01';
  END IF;
  -- Re-read the policy after the workspace counter serializes settings writes.
  -- The early guard cannot see a cap committed while this INSERT waits.
  IF TG_OP='INSERT' AND NEW.status IN ('running','waiting')
     AND EXISTS(SELECT 1 FROM app.workflow_concurrency_policies WHERE workspace_id=NEW.workspace_id
       AND workflow_id=NEW.workflow_id AND active_run_limit IS NOT NULL) THEN
    IF current_setting('app.workflow_concurrency_protocol',true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'workflow concurrency protocol required' USING ERRCODE='PTC01';
    END IF;
    RAISE EXCEPTION 'capped production runs must enter the durable queue' USING ERRCODE='PTC02';
  END IF;
  IF TG_OP='INSERT' THEN
    NEW.admission_ticket:=nextval('app.workflow_run_admission_ticket_seq');
  END IF;
  SELECT queued_runs,active_runs,reserved_active_slots
    INTO actual_queued,actual_active,reserved_active
    FROM app.workflow_run_slot_counts(NEW.workspace_id,NULL,
      CASE WHEN TG_OP='UPDATE' THEN OLD.id ELSE NULL END);
  next_queued:=actual_queued+CASE WHEN NEW.status='queued' THEN 1 ELSE 0 END;
  next_active:=actual_active+reserved_active;
  IF NEW.status IN ('running','waiting') AND NEW.human_wait_started_at IS NULL AND NEW.timed_wait_started_at IS NULL THEN
    IF NOT EXISTS(SELECT 1 FROM app.workflow_calls call
      WHERE call.workspace_id=NEW.workspace_id AND call.parent_run_id=NEW.id AND call.slot_lent) THEN
      next_active:=next_active+1;
    END IF;
  ELSIF TG_OP='UPDATE' AND NEW.status NOT IN ('running','waiting') AND NEW.human_wait_started_at IS NULL AND EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
    WHERE admission.workspace_id=NEW.workspace_id AND admission.workflow_run_id=OLD.id) THEN
    next_active:=next_active+1;
  END IF;
  IF TG_OP='INSERT' THEN
    NEW.execution_entitlement_version:=entitlement.version;
  ELSIF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
     NEW.execution_entitlement_version IS DISTINCT FROM OLD.execution_entitlement_version THEN
    RAISE EXCEPTION 'workflow run admission identity is immutable' USING ERRCODE='55000';
  END IF;
  IF ((TG_OP='INSERT' AND NEW.status='queued') OR
      (TG_OP='UPDATE' AND OLD.status<>'queued' AND NEW.status='queued')) AND
     next_queued>entitlement.queued_run_limit THEN
    RAISE EXCEPTION 'workspace.queued_run_limit_exceeded' USING ERRCODE='PTA02';
  END IF;
  IF ((TG_OP='INSERT' AND NEW.status IN ('running','waiting')) OR
      (TG_OP='UPDATE' AND (OLD.status NOT IN ('running','waiting') OR OLD.human_wait_started_at IS NOT NULL OR OLD.timed_wait_started_at IS NOT NULL)
       AND NEW.status IN ('running','waiting') AND NEW.human_wait_started_at IS NULL AND NEW.timed_wait_started_at IS NULL)) AND
     next_active>entitlement.active_run_limit
     AND NOT EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
       WHERE admission.workspace_id=NEW.workspace_id AND admission.workflow_run_id=NEW.id
         AND admission.borrowed_call_id IS NOT NULL AND (TG_OP='INSERT' OR OLD.human_wait_started_at IS NULL))
     AND NOT EXISTS(SELECT 1 FROM app.workflow_calls loan WHERE loan.workspace_id=NEW.workspace_id AND loan.parent_run_id=NEW.id AND loan.slot_lent) THEN
    RAISE EXCEPTION 'workspace.active_run_limit_exceeded' USING ERRCODE='PTA03';
  END IF;
  IF TG_OP='UPDATE' AND (OLD.status='queued' OR OLD.human_wait_started_at IS NOT NULL) AND NEW.status IN ('running','waiting') AND NEW.human_wait_started_at IS NULL
     AND NOT app.workflow_concurrency_admissible(NEW.workspace_id,NEW.id,false) THEN
    RAISE EXCEPTION 'workflow concurrency admission blocked' USING ERRCODE='PTC02';
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION app.enforce_workflow_run_admission() OWNER TO pertexo_owner;

--
-- Name: execution_artifact_ids(jsonb, text); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.execution_artifact_ids(p_value jsonb, p_format text) RETURNS SETOF uuid
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
  WITH RECURSIVE values_to_check(reference, user_json) AS (
    SELECT p_value, false WHERE p_format IN ('value','checkpoint','event')
    UNION ALL
    SELECT child.value,
      parent.user_json OR p_format='value' OR coalesce(parent.reference->>'kind'='inline',false)
    FROM values_to_check parent
    CROSS JOIN LATERAL (
      SELECT value FROM jsonb_each(
        CASE WHEN jsonb_typeof(parent.reference)='object' THEN parent.reference ELSE '{}'::jsonb END)
      UNION ALL
      SELECT value FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(parent.reference)='array' THEN parent.reference ELSE '[]'::jsonb END)
    ) child
  )
  SELECT DISTINCT (reference->>'artifactId')::uuid FROM values_to_check
  WHERE reference->>'kind'='artifact'
    AND (NOT user_json OR reference ?& ARRAY['byteLength','mediaType','sha256'])
    AND reference->>'artifactId' ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
$_$;


ALTER FUNCTION app.execution_artifact_ids(p_value jsonb, p_format text) OWNER TO pertexo_owner;

--
-- Name: has_pending_invitation(character varying); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.has_pending_invitation(p_normalized_email character varying) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
 SELECT EXISTS (
  SELECT 1 FROM app.workspace_invitations invitation
  WHERE invitation.normalized_email=p_normalized_email
    AND invitation.status='pending'
    AND invitation.expires_at>clock_timestamp()
 )
$$;


ALTER FUNCTION app.has_pending_invitation(p_normalized_email character varying) OWNER TO pertexo_owner;

--
-- Name: index_artifact_owner_references(); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.index_artifact_owner_references() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_row jsonb; v_old jsonb; v_values jsonb:=TG_ARGV[2]::jsonb;
  v_owner uuid; v_sub integer;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    PERFORM app.replace_artifact_owner_references(NULL,TG_TABLE_NAME,NULL,NULL,NULL,'{}');
    RETURN NULL;
  END IF;
  IF TG_OP<>'INSERT' THEN
    v_old:=to_jsonb(OLD);
    IF TG_OP='DELETE' OR
      (v_old->>'workspace_id',v_old->>TG_ARGV[0],coalesce(v_old->>TG_ARGV[1],'0')) IS DISTINCT FROM
      (NEW.workspace_id::text,to_jsonb(NEW)->>TG_ARGV[0],coalesce(to_jsonb(NEW)->>TG_ARGV[1],'0')) THEN
      PERFORM app.replace_artifact_owner_references(
        (v_old->>'workspace_id')::uuid,TG_TABLE_NAME,(v_old->>TG_ARGV[0])::uuid,
        coalesce((v_old->>TG_ARGV[1])::integer,0),NULL,'{}'::jsonb);
    END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN
    v_row:=to_jsonb(NEW);
    -- A SET of an unchanged document need not rewrite its index rows.
    IF TG_OP='UPDATE' AND v_old=v_row THEN RETURN NEW; END IF;
    PERFORM app.replace_artifact_owner_references(
      NEW.workspace_id,TG_TABLE_NAME,(v_row->>TG_ARGV[0])::uuid,
      coalesce((v_row->>TG_ARGV[1])::integer,0),v_row,v_values);
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;


ALTER FUNCTION app.index_artifact_owner_references() OWNER TO pertexo_owner;

--
-- Name: FUNCTION index_artifact_owner_references(); Type: COMMENT; Schema: app; Owner: pertexo_owner
--

COMMENT ON FUNCTION app.index_artifact_owner_references() IS 'Storage-only trigger adapter for the derived reference index. It covers every owner SQL writer and cascade, while source RLS and core retain their existing authority, artifact locks and lifetime rules.';


--
-- Name: instance_artifact_count_limit(); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.instance_artifact_count_limit() RETURNS integer
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'app'
    AS $$ SELECT artifact_count_limit FROM app.instance_capacity $$;


ALTER FUNCTION app.instance_artifact_count_limit() OWNER TO pertexo_owner;

--
-- Name: lend_workflow_run_slot(uuid, uuid, uuid, uuid); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.lend_workflow_run_slot(p_workspace uuid, p_call uuid, p_child uuid, p_outbox uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE v_call app.workflow_calls%ROWTYPE; v_parent_status text; v_admission app.workflow_run_active_admissions%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.workspaces WHERE id=p_workspace FOR KEY SHARE;
  SELECT * INTO v_call FROM app.workflow_calls WHERE workspace_id=p_workspace AND id=p_call;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT status INTO v_parent_status FROM app.workflow_runs
    WHERE workspace_id=p_workspace AND id=v_call.parent_run_id FOR NO KEY UPDATE;
  IF v_parent_status NOT IN ('running','waiting') OR v_parent_status IS NULL THEN RETURN false; END IF;
  SELECT * INTO v_call FROM app.workflow_calls
    WHERE workspace_id=p_workspace AND id=p_call FOR NO KEY UPDATE;
  IF v_call.slot_lent THEN
    RETURN EXISTS(SELECT 1 FROM app.workflow_run_active_admissions
      WHERE workspace_id=p_workspace AND workflow_run_id=p_child AND borrowed_call_id=p_call);
  END IF;
  IF EXISTS(SELECT 1 FROM app.workflow_calls
    WHERE workspace_id=p_workspace AND parent_run_id=v_call.parent_run_id AND slot_lent) THEN RETURN false; END IF;
  PERFORM 1 FROM app.workflow_runs WHERE workspace_id=p_workspace AND id=p_child AND status='queued' FOR KEY SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM app.outbox_events WHERE workspace_id=p_workspace AND id=p_outbox
    AND aggregate_id=p_child AND aggregate_type='workflow-run' AND job_name='advance-workflow-run' FOR KEY SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO v_admission FROM app.workflow_run_active_admissions
    WHERE workspace_id=p_workspace AND workflow_run_id=v_call.parent_run_id FOR UPDATE;
  PERFORM 1 FROM app.workspace_execution_admission_counters WHERE workspace_id=p_workspace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01'; END IF;
  IF NOT app.workflow_concurrency_admissible(p_workspace,p_child,true) THEN RETURN false; END IF;
  UPDATE app.workflow_calls SET slot_lent=true WHERE workspace_id=p_workspace AND id=p_call;
  IF v_admission.workflow_run_id IS NULL THEN
    INSERT INTO app.workflow_run_active_admissions
      (workspace_id,workflow_run_id,outbox_event_id,borrowed_call_id,workflow_concurrency_order_exempt,recover_after)
    VALUES(p_workspace,p_child,p_outbox,p_call,true,clock_timestamp()+interval '5 minutes');
  ELSE
    UPDATE app.workflow_run_active_admissions
      SET workflow_run_id=p_child,outbox_event_id=p_outbox,borrowed_call_id=p_call,
        workflow_concurrency_order_exempt=true,recover_after=clock_timestamp()+interval '5 minutes'
      WHERE workspace_id=p_workspace AND workflow_run_id=v_call.parent_run_id;
  END IF;
  UPDATE app.workspace_execution_admission_counters counter
    SET active_runs=counts.active_runs,queued_runs=counts.queued_runs,reconciled_at=clock_timestamp()
    FROM app.workflow_run_slot_counts(p_workspace) counts WHERE counter.workspace_id=p_workspace;
  RETURN true;
END $$;


ALTER FUNCTION app.lend_workflow_run_slot(p_workspace uuid, p_call uuid, p_child uuid, p_outbox uuid) OWNER TO pertexo_owner;

--
-- Name: lock_execution_artifact_references(); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.lock_execution_artifact_references() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE
  v_artifact_id uuid;
  v_row jsonb;
BEGIN
  -- Summary-only history has no dependencies. Avoid planning five extraction
  -- queries (and serializing the whole row) for every retained-history insert.
  IF TG_TABLE_NAME='workflow_runs' THEN
    IF NEW.input_ref IS NULL AND NEW.output_ref IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  v_row:=to_jsonb(NEW);
  FOR v_artifact_id IN
    SELECT DISTINCT id FROM (
      SELECT app.execution_artifact_ids(v_row->'input_ref','value') id
      UNION ALL SELECT app.execution_artifact_ids(v_row->'output_ref','value')
      UNION ALL SELECT app.execution_artifact_ids(v_row->'reconciliation_ref','value')
      UNION ALL SELECT app.execution_artifact_ids(v_row->'scheduler_state','checkpoint')
      UNION ALL SELECT app.execution_artifact_ids(v_row->'payload','event')
    ) candidates ORDER BY id
  LOOP
    PERFORM 1 FROM app.artifacts artifact
      WHERE artifact.workspace_id=NEW.workspace_id AND artifact.id=v_artifact_id
        AND artifact.status='available' AND artifact.deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'execution artifact reference is unavailable' USING ERRCODE='23503';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;


ALTER FUNCTION app.lock_execution_artifact_references() OWNER TO pertexo_owner;

--
-- Name: lock_webhook_ingress_counter(character); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.lock_webhook_ingress_counter(p_endpoint_key_hash character) RETURNS TABLE(bucket_started_at text, request_count integer, observed_at text, created boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    SET row_security TO 'on'
    AS $$
DECLARE v_endpoint_id uuid; v_workspace_id uuid; v_started timestamptz; v_count integer; v_created boolean;
BEGIN
  SELECT endpoint.id,endpoint.workspace_id INTO v_endpoint_id,v_workspace_id
  FROM app.webhook_trigger_endpoints endpoint
  WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash AND endpoint.status='active';
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO app.webhook_endpoint_ingress_limits(endpoint_id,workspace_id,bucket_started_at,request_count)
  VALUES(v_endpoint_id,v_workspace_id,clock_timestamp(),1)
  ON CONFLICT(endpoint_id) DO NOTHING;
  v_created := FOUND;
  SELECT counter.bucket_started_at,counter.request_count INTO v_started,v_count
  FROM app.webhook_endpoint_ingress_limits counter WHERE counter.endpoint_id=v_endpoint_id FOR UPDATE;
  RETURN QUERY SELECT v_started::text,v_count,clock_timestamp()::text,v_created;
END;
$$;


ALTER FUNCTION app.lock_webhook_ingress_counter(p_endpoint_key_hash character) OWNER TO pertexo_owner;

--
-- Name: lock_workflow_run_replay_source(uuid, uuid); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.lock_workflow_run_replay_source(p_workspace_id uuid, p_source_run_id uuid) RETURNS TABLE(workflow_id uuid, lifecycle_status character varying)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF p_workspace_id IS NULL OR p_source_run_id IS NULL THEN
    RAISE EXCEPTION 'workflow replay source lock arguments are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF p_workspace_id::text IS DISTINCT FROM
      NULLIF(current_setting('app.workspace_id', true), '') THEN
    RAISE EXCEPTION 'workflow replay workspace context mismatch'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT run.workflow_id, workflow.lifecycle_status
      FROM app.workflow_runs AS run
      JOIN app.workflows AS workflow
        ON workflow.workspace_id = run.workspace_id
       AND workflow.id = run.workflow_id
     WHERE run.workspace_id = p_workspace_id
       AND run.id = p_source_run_id
     FOR SHARE OF run, workflow;
END;
$$;


ALTER FUNCTION app.lock_workflow_run_replay_source(p_workspace_id uuid, p_source_run_id uuid) OWNER TO pertexo_owner;

--
-- Name: lock_workflow_run_replay_version(uuid, uuid, uuid); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.lock_workflow_run_replay_version(p_workspace_id uuid, p_workflow_id uuid, p_workflow_version_id uuid) RETURNS TABLE(id uuid, workspace_id uuid, workflow_id uuid, version_number integer, checksum character varying, executable_json json)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF p_workspace_id IS NULL OR p_workflow_id IS NULL
     OR p_workflow_version_id IS NULL THEN
    RAISE EXCEPTION 'workflow replay version lock arguments are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF p_workspace_id::text IS DISTINCT FROM
      NULLIF(current_setting('app.workspace_id', true), '') THEN
    RAISE EXCEPTION 'workflow replay workspace context mismatch'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT workflow_version.id,
           workflow_version.workspace_id,
           workflow_version.workflow_id,
           workflow_version.version_number,
           workflow_version.checksum,
           workflow_version.executable_json
      FROM app.workflow_versions AS workflow_version
     WHERE workflow_version.workspace_id = p_workspace_id
       AND workflow_version.workflow_id = p_workflow_id
       AND workflow_version.id = p_workflow_version_id
     FOR SHARE;
END;
$$;


ALTER FUNCTION app.lock_workflow_run_replay_version(p_workspace_id uuid, p_workflow_id uuid, p_workflow_version_id uuid) OWNER TO pertexo_owner;

--
-- Name: lock_workspace_admission(uuid); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.lock_workspace_admission(p_workspace uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF p_workspace::text IS DISTINCT FROM nullif(current_setting('app.workspace_id', true), '') THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM app.workspace_execution_entitlements current
    JOIN app.workspace_execution_entitlement_versions version
      ON version.workspace_id = current.workspace_id
     AND version.version = current.current_version
    WHERE current.workspace_id = p_workspace
    FOR SHARE OF current, version;
  PERFORM 1 FROM app.workspace_execution_admission_counters
    WHERE workspace_id = p_workspace FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace admission unavailable' USING ERRCODE = 'PTA01';
  END IF;
END
$$;


ALTER FUNCTION app.lock_workspace_admission(p_workspace uuid) OWNER TO pertexo_owner;

--
-- Name: lock_workspace_execution_counter(uuid); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.lock_workspace_execution_counter(p_workspace uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.workspace_execution_admission_counters WHERE workspace_id=p_workspace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01'; END IF;
END $$;


ALTER FUNCTION app.lock_workspace_execution_counter(p_workspace uuid) OWNER TO pertexo_owner;

--
-- Name: lock_workspace_run_admission(uuid); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.lock_workspace_run_admission(p_workspace_id uuid) RETURNS character varying
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE workspace_status varchar;
BEGIN
  IF p_workspace_id::text IS DISTINCT FROM
    nullif(current_setting('app.workspace_id',true),'') THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  SELECT status INTO workspace_status FROM app.workspaces
   WHERE id=p_workspace_id FOR SHARE;
  PERFORM 1 FROM app.workspace_execution_entitlements current
    JOIN app.workspace_execution_entitlement_versions version
      ON version.workspace_id=current.workspace_id AND version.version=current.current_version
    WHERE current.workspace_id=p_workspace_id FOR SHARE OF current,version;
  RETURN workspace_status;
END $$;


ALTER FUNCTION app.lock_workspace_run_admission(p_workspace_id uuid) OWNER TO pertexo_owner;

--
-- Name: lookup_public_form(uuid, character); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.lookup_public_form(p_public_id uuid, p_digest character) RETURNS TABLE(workspace_id uuid, workflow_id uuid, node_id character varying, access character varying, workspace_status character varying)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    SET row_security TO 'on'
    AS $$
  SELECT form.workspace_id,form.workflow_id,form.node_id,form.access,workspace.status
  FROM app.workflow_forms form JOIN app.workspaces workspace ON workspace.id=form.workspace_id
  WHERE form.public_id=p_public_id AND form.capability_hash=p_digest;
$$;


ALTER FUNCTION app.lookup_public_form(p_public_id uuid, p_digest character) OWNER TO pertexo_owner;

--
-- Name: pending_callback_key_inventory(text); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.pending_callback_key_inventory(p_after text) RETURNS TABLE(id uuid, callback_token_hash character, callback_key_version character varying)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
 -- Seek past each version instead of scanning every live callback.
 WITH RECURSIVE samples AS (
   (SELECT task.id,task.callback_token_hash,task.callback_key_version,1 AS sample_number
    FROM app.pending_run_tasks task
    WHERE task.kind='callback' AND task.consumed_at IS NULL AND task.status IN ('prepared','pending','submitted')
      AND task.callback_key_version COLLATE "C">coalesce(p_after,'') COLLATE "C"
    ORDER BY task.callback_key_version COLLATE "C",task.id LIMIT 1)
   UNION ALL
   SELECT candidate.id,candidate.callback_token_hash,candidate.callback_key_version,previous.sample_number+1
   FROM samples previous CROSS JOIN LATERAL (
     SELECT task.id,task.callback_token_hash,task.callback_key_version
     FROM app.pending_run_tasks task
     WHERE task.kind='callback' AND task.consumed_at IS NULL AND task.status IN ('prepared','pending','submitted')
       AND task.callback_key_version COLLATE "C">previous.callback_key_version COLLATE "C"
     ORDER BY task.callback_key_version COLLATE "C",task.id LIMIT 1
   ) candidate WHERE previous.sample_number<250
 ) SELECT id,callback_token_hash,callback_key_version FROM samples ORDER BY callback_key_version COLLATE "C"
$$;


ALTER FUNCTION app.pending_callback_key_inventory(p_after text) OWNER TO pertexo_owner;

--
-- Name: provision_workspace_execution_admission(); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.provision_workspace_execution_admission() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE prior_workspace text;
BEGIN
  -- Capacity is always locked before provisioning entitlement/counter rows. The
  -- updater takes this same singleton lock before scanning committed workspaces.
  PERFORM 1 FROM app.instance_capacity FOR SHARE;
  prior_workspace := current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',NEW.id::text,true);
  INSERT INTO app.workspace_execution_entitlement_versions (
    workspace_id,version,status,active_run_limit,queued_run_limit,effective_at
  ) SELECT NEW.id,1,'active',capacity.active_run_limit,capacity.queued_run_limit,'-infinity'::timestamptz
      FROM app.instance_capacity capacity;
  INSERT INTO app.workspace_execution_entitlements(workspace_id,current_version)
    VALUES (NEW.id,1);
  INSERT INTO app.workspace_execution_admission_counters(workspace_id)
    VALUES (NEW.id);
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RETURN NEW;
END $$;


ALTER FUNCTION app.provision_workspace_execution_admission() OWNER TO pertexo_owner;

--
-- Name: rebind_workflow_run_active_admission(uuid, uuid, uuid, uuid); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.rebind_workflow_run_active_admission(p_workspace_id uuid, p_workflow_run_id uuid, p_old_outbox_event_id uuid, p_new_outbox_event_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  IF p_old_outbox_event_id=p_new_outbox_event_id THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.workflow_runs run
    WHERE run.workspace_id=p_workspace_id AND run.id=p_workflow_run_id AND run.status='queued')
    OR NOT EXISTS(SELECT 1 FROM app.outbox_events old_event,app.outbox_events new_event
      WHERE old_event.workspace_id=p_workspace_id AND old_event.id=p_old_outbox_event_id
        AND new_event.workspace_id=p_workspace_id AND new_event.id=p_new_outbox_event_id
        AND old_event.aggregate_id=p_workflow_run_id AND new_event.aggregate_id=p_workflow_run_id
        AND old_event.aggregate_type='workflow-run' AND new_event.aggregate_type='workflow-run'
        AND old_event.job_name='advance-workflow-run' AND new_event.job_name='advance-workflow-run'

        AND old_event.payload->>'workspaceId'=p_workspace_id::text
        AND new_event.payload->>'workspaceId'=p_workspace_id::text
        AND old_event.payload->>'runId'=p_workflow_run_id::text
        AND new_event.payload->>'runId'=p_workflow_run_id::text
        AND old_event.payload->>'outboxEventId'=p_old_outbox_event_id::text
        AND new_event.payload->>'outboxEventId'=p_new_outbox_event_id::text
        AND new_event.published_at IS NULL AND new_event.failed_at IS NULL) THEN RETURN false;
  END IF;
  UPDATE app.workflow_run_active_admissions SET outbox_event_id=p_new_outbox_event_id,recover_after=CASE WHEN borrowed_call_id IS NULL THEN NULL ELSE clock_timestamp()+interval '5 minutes' END
    WHERE workspace_id=p_workspace_id AND workflow_run_id=p_workflow_run_id
      AND outbox_event_id=p_old_outbox_event_id;
  RETURN FOUND;
END $$;


ALTER FUNCTION app.rebind_workflow_run_active_admission(p_workspace_id uuid, p_workflow_run_id uuid, p_old_outbox_event_id uuid, p_new_outbox_event_id uuid) OWNER TO pertexo_owner;

--
-- Name: recover_due_workflow_run_active_admissions(integer); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.recover_due_workflow_run_active_admissions(p_limit integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE
  admission record;
  canonical_payload text;
  new_outbox_event_id uuid;
  new_payload jsonb;
  old_payload jsonb;
  prior_workspace text;
  recovered integer:=0;
  owner_status text;
  return_parent uuid;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid active admission recovery limit' USING ERRCODE='22023';
  END IF;
  prior_workspace:=current_setting('app.workspace_id',true);
  FOR admission IN
    SELECT active.workspace_id,active.workflow_run_id,active.outbox_event_id,active.borrowed_call_id
      FROM app.workflow_run_active_admissions active
     WHERE active.recover_after<=clock_timestamp()
     ORDER BY active.recover_after,active.outbox_event_id
     FOR UPDATE OF active SKIP LOCKED LIMIT p_limit
  LOOP
    PERFORM set_config('app.workspace_id',admission.workspace_id::text,true);
    SELECT status INTO owner_status FROM app.workflow_runs
      WHERE workspace_id=admission.workspace_id AND id=admission.workflow_run_id;
    IF owner_status IS NULL THEN CONTINUE; END IF;
    IF owner_status<>'queued' THEN
      IF admission.borrowed_call_id IS NULL THEN CONTINUE; END IF;
      IF owner_status IN ('running','waiting') THEN
        -- A bounded recovery batch must progress past live borrowers.
        UPDATE app.workflow_run_active_admissions
          SET recover_after=clock_timestamp()+interval '5 minutes'
          WHERE workspace_id=admission.workspace_id AND workflow_run_id=admission.workflow_run_id;
        CONTINUE;
      END IF;
      SELECT parent_run_id INTO return_parent FROM app.workflow_calls
        WHERE workspace_id=admission.workspace_id AND id=admission.borrowed_call_id
          AND child_run_id=admission.workflow_run_id AND slot_lent;
      IF return_parent IS NULL THEN CONTINUE; END IF;
      new_outbox_event_id:=gen_random_uuid();
      new_payload:=jsonb_build_object('workspaceId',admission.workspace_id,
        'runId',return_parent,'outboxEventId',new_outbox_event_id);
      canonical_payload:='{"outboxEventId":"'||new_outbox_event_id::text||
        '","runId":"'||return_parent::text||'","workspaceId":"'||admission.workspace_id::text||'"}';
      INSERT INTO app.outbox_events(id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum,last_error_code)
        VALUES(new_outbox_event_id,admission.workspace_id,'advance-workflow-run','workflow-run',return_parent,new_payload,
          encode(sha256(convert_to(canonical_payload,'UTF8')),'hex'),'publish.delivery_recovery');
      UPDATE app.workflow_run_active_admissions
        SET recover_after=clock_timestamp()+interval '5 minutes',recovery_count=recovery_count+1
        WHERE workspace_id=admission.workspace_id AND workflow_run_id=admission.workflow_run_id;
      recovered:=recovered+1;
      CONTINUE;
    END IF;
    SELECT payload INTO old_payload FROM app.outbox_events
     WHERE workspace_id=admission.workspace_id
       AND id=admission.outbox_event_id
       AND ((published_at IS NOT NULL AND failed_at IS NULL)
         OR (admission.borrowed_call_id IS NOT NULL AND failed_at IS NOT NULL));
    IF FOUND THEN
      new_outbox_event_id:=gen_random_uuid();
      new_payload:=old_payload||jsonb_build_object('outboxEventId',new_outbox_event_id);
      canonical_payload:='{"outboxEventId":"'||new_outbox_event_id::text||
        '","runId":"'||admission.workflow_run_id::text||
        '"'||
        CASE WHEN old_payload?'traceparent'
          THEN ',"traceparent":'||to_jsonb(old_payload->>'traceparent')::text
          ELSE '' END||
        ',"workspaceId":"'||admission.workspace_id::text||'"}';
      INSERT INTO app.outbox_events(
        id,workspace_id,job_name,aggregate_type,aggregate_id,
        payload,payload_checksum,available_at,last_error_code
      ) VALUES(
        new_outbox_event_id,admission.workspace_id,'advance-workflow-run',
        'workflow-run',admission.workflow_run_id,new_payload,
        encode(sha256(convert_to(canonical_payload,'UTF8')),'hex'),
        clock_timestamp(),'publish.delivery_recovery'
      );
      UPDATE app.workflow_run_active_admissions
         SET outbox_event_id=new_outbox_event_id,
           recover_after=CASE WHEN borrowed_call_id IS NULL THEN NULL ELSE clock_timestamp()+interval '5 minutes' END,
             recovery_count=recovery_count+1
       WHERE workflow_run_id=admission.workflow_run_id;
      recovered:=recovered+1;
    ELSIF admission.borrowed_call_id IS NOT NULL THEN
      -- The dispatcher still owns this unpublished hint; retain the slot and
      -- move the poll behind other due return obligations.
      UPDATE app.workflow_run_active_admissions
        SET recover_after=clock_timestamp()+interval '5 minutes'
        WHERE workspace_id=admission.workspace_id AND workflow_run_id=admission.workflow_run_id;
    END IF;
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RETURN recovered;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END $$;


ALTER FUNCTION app.recover_due_workflow_run_active_admissions(p_limit integer) OWNER TO pertexo_owner;

--
-- Name: refresh_workflow_run_admission_counters(); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.refresh_workflow_run_admission_counters() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF NEW.status<>'queued' THEN
    DELETE FROM app.workflow_run_active_admissions
     WHERE workspace_id=NEW.workspace_id AND workflow_run_id=NEW.id AND borrowed_call_id IS NULL;
  END IF;
  UPDATE app.workspace_execution_admission_counters counter
     SET queued_runs=counts.queued_runs, active_runs=counts.active_runs,
         reconciled_at=clock_timestamp()
    FROM app.workflow_run_slot_counts(NEW.workspace_id) counts
   WHERE counter.workspace_id=NEW.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01';
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION app.refresh_workflow_run_admission_counters() OWNER TO pertexo_owner;

--
-- Name: release_dispatcher_workflow_run_active_admission(uuid, uuid); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.release_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  DELETE FROM app.workflow_run_active_admissions
   WHERE workspace_id=p_workspace_id AND outbox_event_id=p_outbox_event_id AND borrowed_call_id IS NULL;
  RETURN FOUND;
END $$;


ALTER FUNCTION app.release_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) OWNER TO pertexo_owner;

--
-- Name: release_trigger_schedule_claim(uuid, uuid); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.release_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid) RETURNS boolean
    LANGUAGE sql
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
  UPDATE app.trigger_schedules SET lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,
    lease_expires_at=NULL,updated_at=clock_timestamp()
   WHERE trigger_id=p_trigger_id AND lease_token=p_lease_token RETURNING true
$$;


ALTER FUNCTION app.release_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid) OWNER TO pertexo_owner;

--
-- Name: release_workflow_run_active_admission(uuid, uuid); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.release_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  DELETE FROM app.workflow_run_active_admissions
   WHERE workspace_id=p_workspace_id AND outbox_event_id=p_outbox_event_id AND borrowed_call_id IS NULL;
  RETURN FOUND;
END $$;


ALTER FUNCTION app.release_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) OWNER TO pertexo_owner;

--
-- Name: replace_artifact_owner_references(uuid, text, uuid, integer, jsonb, jsonb); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.replace_artifact_owner_references(p_workspace uuid, p_family text, p_owner uuid, p_sub_id integer, p_row jsonb, p_values jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_scope text:=current_setting('app.workspace_id',true); v_workspace uuid;
BEGIN
  IF p_workspace IS NULL THEN
    -- Owner-table TRUNCATE is global; its statement trigger uses this same writer.
    FOR v_workspace IN SELECT id FROM app.workspaces LOOP
      PERFORM app.replace_artifact_owner_references(v_workspace,p_family,NULL,NULL,NULL,'{}');
    END LOOP;
    RETURN;
  END IF;
  -- The trigger already runs after the source table's workspace/RLS check.
  -- Maintenance can touch several workspaces; restore its context after this row.
  PERFORM set_config('app.workspace_id',p_workspace::text,true);
  DELETE FROM app.artifact_owner_references
    WHERE workspace_id=p_workspace AND owner_family=p_family
      AND (p_owner IS NULL OR owner_id=p_owner) AND (p_sub_id IS NULL OR owner_sub_id=p_sub_id);
  INSERT INTO app.artifact_owner_references
    (workspace_id,artifact_id,owner_family,owner_id,owner_sub_id,owner_slot)
    SELECT DISTINCT p_workspace,reference,p_family,p_owner,p_sub_id,source.key
    FROM jsonb_each_text(p_values) source
    CROSS JOIN LATERAL app.artifact_owner_ids(p_row->source.key,source.value) reference
    ON CONFLICT DO NOTHING;
  PERFORM set_config('app.workspace_id',coalesce(v_scope,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_scope,''),true);
  RAISE;
END $$;


ALTER FUNCTION app.replace_artifact_owner_references(p_workspace uuid, p_family text, p_owner uuid, p_sub_id integer, p_row jsonb, p_values jsonb) OWNER TO pertexo_owner;

--
-- Name: FUNCTION replace_artifact_owner_references(p_workspace uuid, p_family text, p_owner uuid, p_sub_id integer, p_row jsonb, p_values jsonb); Type: COMMENT; Schema: app; Owner: pertexo_owner
--

COMMENT ON FUNCTION app.replace_artifact_owner_references(p_workspace uuid, p_family text, p_owner uuid, p_sub_id integer, p_row jsonb, p_values jsonb) IS 'Single derived-index writer. Only the owner-only trigger adapter and migration backfill call it; JSON remains authoritative. Atomic replacement has the source row lock, and preserves the caller workspace context.';


--
-- Name: require_workflow_skip_protocol(); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.require_workflow_skip_protocol() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF current_setting('app.workflow_concurrency_skip_protocol',true) IS DISTINCT FROM '1'
    AND EXISTS(SELECT 1 FROM app.workflow_concurrency_policies
      WHERE workspace_id=NEW.workspace_id AND workflow_id=NEW.workflow_id
        AND active_run_limit IS NOT NULL AND overflow='skip') THEN
    RAISE EXCEPTION 'workflow skip admission protocol required' USING ERRCODE='PTC01';
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION app.require_workflow_skip_protocol() OWNER TO pertexo_owner;

--
-- Name: reserve_workflow_run_active_admission(uuid, uuid, uuid); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.reserve_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
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


ALTER FUNCTION app.reserve_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid) OWNER TO pertexo_owner;

--
-- Name: resolve_public_pending_callback(character); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.resolve_public_pending_callback(p_hash character) RETURNS TABLE(id uuid, workspace_id uuid, run_id uuid, callback_node_id character varying, callback_scope_hash character, callback_token_hash character, callback_key_version character varying, config jsonb, database_time timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
 SELECT task.id,task.workspace_id,task.run_id,task.callback_node_id,task.callback_scope_hash,task.callback_token_hash,task.callback_key_version,task.config,clock_timestamp()
 FROM app.pending_run_tasks task WHERE task.kind='callback' AND task.callback_token_hash=p_hash
$$;


ALTER FUNCTION app.resolve_public_pending_callback(p_hash character) OWNER TO pertexo_owner;

--
-- Name: resolve_public_webhook_endpoint(character); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.resolve_public_webhook_endpoint(p_endpoint_key_hash character) RETURNS TABLE(endpoint_id uuid, workspace_id uuid, trigger_id uuid, workflow_id uuid, workflow_version_id uuid, node_id character varying, current_secret_version_id uuid, current_secret_trigger_id uuid, current_kms_key_reference character varying, current_encrypted_data_key text, current_ciphertext text, current_nonce character varying, current_auth_tag character varying, previous_secret_version_id uuid, previous_secret_trigger_id uuid, previous_secret_valid_until timestamp with time zone, previous_kms_key_reference character varying, previous_encrypted_data_key text, previous_ciphertext text, previous_nonce character varying, previous_auth_tag character varying, database_time timestamp with time zone, authentication jsonb, endpoint_status character varying, workflow_lifecycle_status character varying, workspace_status character varying)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE
  resolved_workspace uuid;
  prior_workspace text;
BEGIN
  prior_workspace := current_setting('app.workspace_id',true);
  SELECT endpoint.workspace_id INTO resolved_workspace
    FROM app.webhook_trigger_endpoints endpoint
   WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash;
  IF resolved_workspace IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.workspace_id',resolved_workspace::text,true);
  -- A door around row security: it finds the step this address answers for, from the moment a
  -- publish commits, and reports the statuses. Whether they let a delivery in is core's rule
  -- (triggers/webhooks/runtime/endpoint-rules.ts), used here and again under the admission locks.
  RETURN QUERY SELECT endpoint.id,endpoint.workspace_id,trigger.id,trigger.workflow_id,
         trigger.workflow_version_id,trigger.node_id,current_secret.id,current_secret.trigger_id,
         current_secret.kms_key_reference,
         current_secret.encrypted_data_key,current_secret.ciphertext,current_secret.nonce,current_secret.auth_tag,
         previous_secret.id,previous_secret.trigger_id,endpoint.previous_secret_valid_until,
         previous_secret.kms_key_reference,
         previous_secret.encrypted_data_key,previous_secret.ciphertext,previous_secret.nonce,previous_secret.auth_tag,
         clock_timestamp(),endpoint.authentication,
         endpoint.status,workflow.lifecycle_status,workspace.status
    FROM app.webhook_trigger_endpoints endpoint
    JOIN app.workflows workflow ON workflow.workspace_id=endpoint.workspace_id AND workflow.id=endpoint.workflow_id
    JOIN app.workflow_triggers trigger
      ON trigger.workspace_id=endpoint.workspace_id AND trigger.workflow_id=endpoint.workflow_id
     AND trigger.node_id=endpoint.node_id AND trigger.workflow_version_id=workflow.published_version_id
     AND trigger.kind='webhook'
    JOIN app.workspaces workspace ON workspace.id=endpoint.workspace_id
    JOIN app.webhook_trigger_secret_versions current_secret
      ON current_secret.workspace_id=endpoint.workspace_id AND current_secret.id=endpoint.current_secret_version_id
    LEFT JOIN app.webhook_trigger_secret_versions previous_secret
      ON previous_secret.workspace_id=endpoint.workspace_id AND previous_secret.id=endpoint.previous_secret_version_id
     AND endpoint.previous_secret_valid_until>clock_timestamp()
   WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END $$;


ALTER FUNCTION app.resolve_public_webhook_endpoint(p_endpoint_key_hash character) OWNER TO pertexo_owner;

--
-- Name: resolve_webhook_test_event(character); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.resolve_webhook_test_event(p_key_hash character) RETURNS TABLE(workspace_id uuid, id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$ SELECT event.workspace_id,event.id FROM app.webhook_test_events event
 WHERE event.endpoint_key_hash=p_key_hash AND event.output_ref IS NULL
 AND event.expires_at>clock_timestamp() $$;


ALTER FUNCTION app.resolve_webhook_test_event(p_key_hash character) OWNER TO pertexo_owner;

--
-- Name: return_workflow_run_slot(uuid, uuid, uuid); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.return_workflow_run_slot(p_workspace uuid, p_call uuid, p_parent_outbox uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE v_parent app.workflow_runs%ROWTYPE; v_call app.workflow_calls%ROWTYPE; v_incoming uuid; v_owner uuid;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.workspaces WHERE id=p_workspace FOR KEY SHARE;
  SELECT * INTO v_call FROM app.workflow_calls WHERE workspace_id=p_workspace AND id=p_call;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO v_parent FROM app.workflow_runs
    WHERE workspace_id=p_workspace AND id=v_call.parent_run_id FOR NO KEY UPDATE;
  SELECT * INTO v_call FROM app.workflow_calls
    WHERE workspace_id=p_workspace AND id=p_call FOR NO KEY UPDATE;
  IF NOT v_call.slot_lent THEN RETURN false; END IF;
  PERFORM 1 FROM app.outbox_events WHERE workspace_id=p_workspace AND id=p_parent_outbox
    AND aggregate_id=v_call.parent_run_id AND aggregate_type='workflow-run' AND job_name='advance-workflow-run' FOR KEY SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT id INTO v_incoming FROM app.workflow_calls
    WHERE workspace_id=p_workspace AND child_run_id=v_call.parent_run_id AND slot_lent;
  IF v_incoming IS NOT NULL THEN
    PERFORM 1 FROM app.workflow_calls WHERE workspace_id=p_workspace AND id=v_incoming FOR KEY SHARE;
  END IF;
  SELECT workflow_run_id INTO v_owner FROM app.workflow_run_active_admissions
    WHERE workspace_id=p_workspace AND workflow_run_id=v_call.child_run_id AND borrowed_call_id=p_call FOR UPDATE;
  -- A nested borrower still owning the slot must return it one level first.
  IF v_owner IS NULL THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM app.workflow_runs WHERE workspace_id=p_workspace AND id=v_owner
    AND status IN ('queued','running','waiting')) THEN RETURN false; END IF;
  PERFORM 1 FROM app.workspace_execution_admission_counters WHERE workspace_id=p_workspace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace admission state missing' USING ERRCODE='PTA01'; END IF;
  -- A child that ended while suspended no longer owns a workspace slot.
  -- A live, resumed parent must compete for fresh capacity before its loan ends.
  IF v_parent.status IN ('running','waiting') AND v_parent.human_wait_started_at IS NULL
     AND EXISTS(SELECT 1 FROM app.workflow_runs child WHERE child.workspace_id=p_workspace AND child.id=v_owner AND child.human_wait_started_at IS NOT NULL)
     AND (SELECT active_runs+reserved_active_slots FROM app.workflow_run_slot_counts(p_workspace)) >=
       (SELECT active_run_limit FROM app.workspace_execution_entitlement_versions WHERE workspace_id=p_workspace AND version=v_parent.execution_entitlement_version)
  THEN RETURN false; END IF;
  UPDATE app.workflow_calls SET slot_lent=false WHERE workspace_id=p_workspace AND id=p_call;
  IF v_incoming IS NULL THEN
    DELETE FROM app.workflow_run_active_admissions
      WHERE workspace_id=p_workspace AND workflow_run_id=v_owner AND borrowed_call_id=p_call;
  ELSE
    UPDATE app.workflow_run_active_admissions
      SET workflow_run_id=v_call.parent_run_id,outbox_event_id=p_parent_outbox,borrowed_call_id=v_incoming,
        workflow_concurrency_order_exempt=true,recover_after=clock_timestamp()+interval '5 minutes'
      WHERE workspace_id=p_workspace AND workflow_run_id=v_owner AND borrowed_call_id=p_call;
  END IF;
  UPDATE app.workspace_execution_admission_counters counter
    SET active_runs=counts.active_runs,queued_runs=counts.queued_runs,reconciled_at=clock_timestamp()
    FROM app.workflow_run_slot_counts(p_workspace) counts WHERE counter.workspace_id=p_workspace;
  RETURN true;
END $$;


ALTER FUNCTION app.return_workflow_run_slot(p_workspace uuid, p_call uuid, p_parent_outbox uuid) OWNER TO pertexo_owner;

--
-- Name: revoke_auth_sessions_for_email_change(); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.revoke_auth_sessions_for_email_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  DELETE FROM app.auth_sessions WHERE user_id=NEW.id;
  RETURN NEW;
END;
$$;


ALTER FUNCTION app.revoke_auth_sessions_for_email_change() OWNER TO pertexo_owner;

--
-- Name: FUNCTION revoke_auth_sessions_for_email_change(); Type: COMMENT; Schema: app; Owner: pertexo_owner
--

COMMENT ON FUNCTION app.revoke_auth_sessions_for_email_change() IS 'security integrity: holds for every writer. Keep session revocation atomic with an email change, including direct operator SQL and authentication-library writes. This trigger is the single owner of this rule.';


--
-- Name: revoke_auth_sessions_for_inactive_user(); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.revoke_auth_sessions_for_inactive_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF OLD.status='active' AND NEW.status<>'active' THEN
    DELETE FROM app.auth_sessions WHERE user_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION app.revoke_auth_sessions_for_inactive_user() OWNER TO pertexo_owner;

--
-- Name: FUNCTION revoke_auth_sessions_for_inactive_user(); Type: COMMENT; Schema: app; Owner: pertexo_owner
--

COMMENT ON FUNCTION app.revoke_auth_sessions_for_inactive_user() IS 'security integrity: holds for every writer. Keep session revocation atomic when an active global user becomes inactive, including direct operator SQL and authentication-library writes. This trigger is the single owner of this rule.';


--
-- Name: revoke_auth_sessions_for_workspace_unavailability(); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.revoke_auth_sessions_for_workspace_unavailability() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_prior_workspace text;
BEGIN
  v_prior_workspace:=current_setting('app.workspace_id',true);
  PERFORM set_config('app.workspace_id',NEW.id::text,true);
  DELETE FROM app.auth_sessions
   WHERE user_id IN (
     SELECT membership.user_id
       FROM app.workspace_memberships membership
      WHERE membership.workspace_id=NEW.id
        AND membership.status<>'removed'
   );
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END;
$$;


ALTER FUNCTION app.revoke_auth_sessions_for_workspace_unavailability() OWNER TO pertexo_owner;

--
-- Name: FUNCTION revoke_auth_sessions_for_workspace_unavailability(); Type: COMMENT; Schema: app; Owner: pertexo_owner
--

COMMENT ON FUNCTION app.revoke_auth_sessions_for_workspace_unavailability() IS 'security integrity: holds for every writer. Keep non-removed members session revocation atomic with workspace unavailability, including direct operator SQL. This trigger is the single owner of this rule.';


--
-- Name: signal_outbox_rows(); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.signal_outbox_rows() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- A statement-level trigger fires for an insert of no rows too, and the worker's
  -- scans run those many times a second.
  IF EXISTS (SELECT 1 FROM new_rows) THEN
    PERFORM pg_notify('outbox_rows', '');
  END IF;
  RETURN NULL;
END;
$$;


ALTER FUNCTION app.signal_outbox_rows() OWNER TO pertexo_owner;

--
-- Name: store_trigger_schedule_retirement(uuid, uuid, text, text, timestamp with time zone); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.store_trigger_schedule_retirement(p_trigger_id uuid, p_lease_token uuid, p_health_status text, p_error_code text, p_deferred_until timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    SET row_security TO 'on'
    AS $$
DECLARE v_workspace_id uuid; v_previous_workspace text := current_setting('app.workspace_id',true);
BEGIN
  UPDATE app.trigger_schedules SET
    lease_owner=NULL,lease_token=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
    health_status=p_health_status,last_error_code=p_error_code,
    admission_deferred_until=p_deferred_until,updated_at=clock_timestamp()
  WHERE trigger_id=p_trigger_id AND lease_token=p_lease_token
    AND lease_expires_at>clock_timestamp()
  RETURNING workspace_id INTO v_workspace_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM set_config('app.workspace_id',v_workspace_id::text,true);
  UPDATE app.workflow_triggers SET health_status=p_health_status,
    last_error_code=p_error_code,updated_at=clock_timestamp()
  WHERE id=p_trigger_id AND workspace_id=v_workspace_id;
  PERFORM set_config('app.workspace_id',coalesce(v_previous_workspace,''),true);
  RETURN true;
END;
$$;


ALTER FUNCTION app.store_trigger_schedule_retirement(p_trigger_id uuid, p_lease_token uuid, p_health_status text, p_error_code text, p_deferred_until timestamp with time zone) OWNER TO pertexo_owner;

--
-- Name: store_webhook_ingress_counter(character, timestamp with time zone, integer, boolean, timestamp with time zone); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.store_webhook_ingress_counter(p_endpoint_key_hash character, p_expected_window timestamp with time zone, p_expected_count integer, p_reset boolean, p_window timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    SET row_security TO 'on'
    AS $$
BEGIN
  UPDATE app.webhook_endpoint_ingress_limits counter
  SET bucket_started_at=p_window,request_count=CASE WHEN p_reset THEN 1 ELSE counter.request_count+1 END,
    updated_at=clock_timestamp()
  FROM app.webhook_trigger_endpoints endpoint
  WHERE counter.endpoint_id=endpoint.id AND endpoint.endpoint_key_hash=p_endpoint_key_hash
    AND endpoint.status='active' AND counter.bucket_started_at=p_expected_window AND counter.request_count=p_expected_count;
  RETURN FOUND;
END;
$$;


ALTER FUNCTION app.store_webhook_ingress_counter(p_endpoint_key_hash character, p_expected_window timestamp with time zone, p_expected_count integer, p_reset boolean, p_window timestamp with time zone) OWNER TO pertexo_owner;

--
-- Name: workflow_concurrency_admissible(uuid, uuid, boolean); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.workflow_concurrency_admissible(p_workspace uuid, p_run uuid, p_grant boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE v_run app.workflow_runs%ROWTYPE; v_limit integer; v_reserved boolean; v_exempt boolean;
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_run FROM app.workflow_runs WHERE workspace_id=p_workspace AND id=p_run;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_run.status<>'queued' AND v_run.human_wait_started_at IS NULL THEN RETURN true; END IF;
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
  IF v_reserved AND v_run.human_wait_started_at IS NULL AND (p_grant OR v_exempt) THEN RETURN true; END IF;
  IF (NOT coalesce(v_reserved,false) OR v_run.human_wait_started_at IS NOT NULL) AND
    (SELECT active_runs+reserved_active_slots
      FROM app.workflow_run_slot_counts(p_workspace,v_run.workflow_id))>=v_limit THEN
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


ALTER FUNCTION app.workflow_concurrency_admissible(p_workspace uuid, p_run uuid, p_grant boolean) OWNER TO pertexo_owner;

--
-- Name: workflow_run_active_admission_eligible(uuid, uuid, uuid); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.workflow_run_active_admission_eligible(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
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
          AND (SELECT active_runs+reserved_active_slots
            FROM app.workflow_run_slot_counts(p_workspace_id))<v_limit));
    END IF;
  END IF;
  PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RETURN coalesce(v_result,false);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.workspace_id',coalesce(v_prior,''),true); RAISE;
END $$;


ALTER FUNCTION app.workflow_run_active_admission_eligible(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid) OWNER TO pertexo_owner;

--
-- Name: workflow_run_active_capacity_available(uuid, integer, uuid); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.workflow_run_active_capacity_available(p_workspace_id uuid, p_entitlement_version integer, p_workflow_run_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE active_limit integer; active_count integer; reserved_count integer;
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
  SELECT active_runs,reserved_active_slots INTO active_count,reserved_count
    FROM app.workflow_run_slot_counts(p_workspace_id,NULL,p_workflow_run_id);
  RETURN (
    EXISTS(SELECT 1 FROM app.workflow_run_active_admissions admission
      WHERE admission.workspace_id=p_workspace_id AND admission.workflow_run_id=p_workflow_run_id
        AND admission.borrowed_call_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM app.workflow_runs paused WHERE paused.workspace_id=p_workspace_id AND paused.id=p_workflow_run_id AND paused.human_wait_started_at IS NOT NULL))
    OR EXISTS(SELECT 1 FROM app.workflow_calls loan WHERE loan.workspace_id=p_workspace_id AND loan.parent_run_id=p_workflow_run_id AND loan.slot_lent)
    OR active_count+reserved_count<active_limit);
END $$;


ALTER FUNCTION app.workflow_run_active_capacity_available(p_workspace_id uuid, p_entitlement_version integer, p_workflow_run_id uuid) OWNER TO pertexo_owner;

--
-- Name: workflow_run_slot_counts(uuid, uuid, uuid); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.workflow_run_slot_counts(p_workspace uuid, p_workflow uuid DEFAULT NULL::uuid, p_excluded_run uuid DEFAULT NULL::uuid) RETURNS TABLE(active_runs integer, reserved_active_slots integer, queued_runs integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
BEGIN
  IF nullif(current_setting('app.workspace_id',true),'')::uuid IS DISTINCT FROM p_workspace THEN
    RAISE EXCEPTION 'workspace context mismatch' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT
    (SELECT count(*)::integer FROM app.workflow_runs run
      WHERE run.workspace_id=p_workspace AND run.status IN ('running','waiting') AND run.human_wait_started_at IS NULL
        -- A timed Wait holds no workspace slot, but keeps its place in the workflow's own limit.
        AND (p_workflow IS NOT NULL OR run.timed_wait_started_at IS NULL)
        AND (p_workflow IS NULL OR run.workflow_id=p_workflow)
        AND (p_excluded_run IS NULL OR run.id<>p_excluded_run)
        AND (p_workflow IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM app.workflow_calls call WHERE call.workspace_id=p_workspace
            AND call.parent_run_id=run.id AND call.slot_lent))),
    (SELECT count(*)::integer FROM app.workflow_run_active_admissions admission
      JOIN app.workflow_runs run
        ON run.workspace_id=admission.workspace_id AND run.id=admission.workflow_run_id
      WHERE admission.workspace_id=p_workspace AND run.human_wait_started_at IS NULL AND run.status NOT IN ('running','waiting')
        AND (p_workflow IS NULL OR (run.workflow_id=p_workflow AND run.status='queued'))
        AND (p_excluded_run IS NULL OR run.id<>p_excluded_run)),
    (SELECT count(*)::integer FROM app.workflow_runs run
      WHERE run.workspace_id=p_workspace AND run.status='queued'
        AND (p_workflow IS NULL OR run.workflow_id=p_workflow)
        AND (p_excluded_run IS NULL OR run.id<>p_excluded_run));
END $$;


ALTER FUNCTION app.workflow_run_slot_counts(p_workspace uuid, p_workflow uuid, p_excluded_run uuid) OWNER TO pertexo_owner;

--
-- Name: workspace_inbox_recipient_eligible(uuid, uuid); Type: FUNCTION; Schema: app; Owner: pertexo_owner
--

CREATE FUNCTION app.workspace_inbox_recipient_eligible(p_workspace_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'app'
    AS $$
 SELECT p_workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid AND p_user_id::text=NULLIF(current_setting('app.actor_id',true),'') AND EXISTS(
 SELECT 1 FROM app.workspace_memberships m JOIN app.workspaces w ON w.id=m.workspace_id JOIN app.users u ON u.id=m.user_id WHERE m.workspace_id=p_workspace_id AND m.user_id=p_user_id AND m.status='active' AND w.status IN ('active','suspended') AND u.status='active');
$$;


ALTER FUNCTION app.workspace_inbox_recipient_eligible(p_workspace_id uuid, p_user_id uuid) OWNER TO pertexo_owner;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_tokens; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.api_tokens (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    name character varying(128) NOT NULL,
    secret_digest character(64) NOT NULL,
    scopes jsonb NOT NULL,
    membership_revision integer NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    CONSTRAINT api_tokens_digest_valid CHECK ((secret_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT api_tokens_expiry_valid CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '8760:00:00'::interval)))),
    CONSTRAINT api_tokens_name_bounded CHECK (((length(btrim((name)::text)) >= 1) AND (length(btrim((name)::text)) <= 128))),
    CONSTRAINT api_tokens_revision_positive CHECK ((membership_revision > 0)),
    CONSTRAINT api_tokens_scopes_valid CHECK (((jsonb_typeof(scopes) = 'array'::text) AND ((jsonb_array_length(scopes) >= 1) AND (jsonb_array_length(scopes) <= 11)) AND (scopes <@ '["workflow:read", "workflow:create", "workflow:update", "workflow:publish", "run:read", "run:read-data", "run:start", "run:cancel", "connection:read", "workspace:read", "variable:manage"]'::jsonb)))
);


ALTER TABLE app.api_tokens OWNER TO pertexo_owner;

--
-- Name: artifact_links; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.artifact_links (
    workspace_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    owner_kind character varying(32) NOT NULL,
    owner_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT artifact_links_owner_kind_valid CHECK (((owner_kind)::text = 'preview_run'::text))
);


ALTER TABLE app.artifact_links OWNER TO pertexo_owner;

--
-- Name: artifact_owner_references; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.artifact_owner_references (
    workspace_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    owner_family character varying(40) NOT NULL,
    owner_id uuid NOT NULL,
    owner_sub_id integer NOT NULL,
    owner_slot character varying(32) NOT NULL,
    CONSTRAINT artifact_owner_references_family_valid CHECK (((owner_family)::text = ANY ((ARRAY['workflow_drafts'::character varying, 'workflow_versions'::character varying, 'workflow_test_snapshots'::character varying, 'workflow_test_suite_cases'::character varying, 'workflow_input_case_payloads'::character varying, 'workflow_step_samples'::character varying, 'preview_runs'::character varying, 'workflow_runs'::character varying, 'node_runs'::character varying, 'node_attempts'::character varying, 'run_events'::character varying, 'run_checkpoints'::character varying, 'pending_run_tasks'::character varying])::text[]))),
    CONSTRAINT artifact_owner_references_sub_id_valid CHECK ((owner_sub_id >= 0))
);


ALTER TABLE app.artifact_owner_references OWNER TO pertexo_owner;

--
-- Name: artifacts; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.artifacts (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    purpose character varying(64) NOT NULL,
    storage_key character varying(512) NOT NULL,
    media_type character varying(255) NOT NULL,
    byte_length bigint NOT NULL,
    sha256 character(64) NOT NULL,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    finalized_at timestamp with time zone,
    deleted_at timestamp with time zone,
    retention_retry_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT artifacts_byte_length_bounded CHECK (((byte_length >= 0) AND (byte_length <= '5368709120'::bigint))),
    CONSTRAINT artifacts_lifecycle_timestamps CHECK (((((status)::text = 'pending'::text) AND (finalized_at IS NULL) AND (deleted_at IS NULL)) OR (((status)::text = 'available'::text) AND (finalized_at IS NOT NULL) AND (deleted_at IS NULL)) OR (((status)::text = 'deleting'::text) AND (deleted_at IS NULL)) OR (((status)::text = 'deleted'::text) AND (deleted_at IS NOT NULL)))),
    CONSTRAINT artifacts_media_type_format CHECK (((length((media_type)::text) >= 3) AND (length((media_type)::text) <= 255) AND ((media_type)::text ~ (('^[^[:space:]/'::text || chr(59)) || ']+/[^\r\n]+$'::text)) AND ((media_type)::text !~ '[^	 -~-ÿ]'::text))),
    CONSTRAINT artifacts_purpose_format CHECK (((purpose)::text ~ '^[a-z][a-z0-9-]{0,63}$'::text)),
    CONSTRAINT artifacts_sha256_format CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT artifacts_status_value CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('available'::character varying)::text, ('deleting'::character varying)::text, ('deleted'::character varying)::text]))),
    CONSTRAINT artifacts_storage_key_scope CHECK (((storage_key)::text = ((('workspaces/'::text || (workspace_id)::text) || '/artifacts/'::text) || (id)::text)))
);


ALTER TABLE app.artifacts OWNER TO pertexo_owner;

--
-- Name: audit_events; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.audit_events (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    actor_user_id uuid,
    action character varying(128) NOT NULL,
    target_type character varying(64) NOT NULL,
    target_id uuid,
    request_id character varying(128),
    trace_id character varying(128),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT audit_events_action_format CHECK (((action)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT audit_events_metadata_bounded CHECK ((octet_length((metadata)::text) <= 8192)),
    CONSTRAINT audit_events_preview_terminal_uuid_v7 CHECK ((((action)::text <> 'preview.execution_terminal'::text) OR (uuid_extract_version(id) = 7))),
    CONSTRAINT audit_events_request_id_bounded CHECK (((request_id IS NULL) OR ((length((request_id)::text) >= 1) AND (length((request_id)::text) <= 128)))),
    CONSTRAINT audit_events_target_type_format CHECK (((target_type)::text ~ '^[a-z][a-z0-9._:-]{0,63}$'::text)),
    CONSTRAINT audit_events_trace_id_bounded CHECK (((trace_id IS NULL) OR ((length((trace_id)::text) >= 1) AND (length((trace_id)::text) <= 128))))
);


ALTER TABLE app.audit_events OWNER TO pertexo_owner;

--
-- Name: auth_accounts; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_accounts (
    id uuid NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


ALTER TABLE app.auth_accounts OWNER TO pertexo_owner;

--
-- Name: auth_directory_group_mappings; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_directory_group_mappings (
    organization_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    group_id uuid NOT NULL,
    role text NOT NULL,
    priority integer NOT NULL,
    CONSTRAINT auth_directory_group_mapping_priority_valid CHECK (((priority >= 0) AND (priority <= 199))),
    CONSTRAINT auth_directory_group_mapping_role_valid CHECK ((role = ANY (ARRAY['viewer'::text, 'operator'::text, 'builder'::text, 'admin'::text])))
);


ALTER TABLE app.auth_directory_group_mappings OWNER TO pertexo_owner;

--
-- Name: auth_directory_group_members; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_directory_group_members (
    organization_id uuid NOT NULL,
    group_id uuid NOT NULL,
    directory_user_id uuid NOT NULL
);


ALTER TABLE app.auth_directory_group_members OWNER TO pertexo_owner;

--
-- Name: auth_directory_groups; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_directory_groups (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    display_name text NOT NULL,
    external_id text,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT auth_directory_group_external_valid CHECK (((external_id IS NULL) OR ((length(external_id) >= 1) AND (length(external_id) <= 512)))),
    CONSTRAINT auth_directory_group_name_valid CHECK (((length(btrim(display_name)) >= 1) AND (length(btrim(display_name)) <= 256))),
    CONSTRAINT auth_directory_group_revision_positive CHECK ((revision > 0))
);


ALTER TABLE app.auth_directory_groups OWNER TO pertexo_owner;

--
-- Name: auth_directory_memberships; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_directory_memberships (
    organization_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    directory_user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


ALTER TABLE app.auth_directory_memberships OWNER TO pertexo_owner;

--
-- Name: auth_directory_users; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_directory_users (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_name text NOT NULL,
    normalized_user_name text NOT NULL,
    login_email text NOT NULL,
    external_id text,
    active boolean DEFAULT true NOT NULL,
    profile jsonb NOT NULL,
    user_id uuid,
    revision integer DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT auth_directory_user_deleted_inactive CHECK (((deleted_at IS NULL) OR (NOT active))),
    CONSTRAINT auth_directory_user_email_valid CHECK (((length(login_email) >= 3) AND (length(login_email) <= 320))),
    CONSTRAINT auth_directory_user_external_valid CHECK (((external_id IS NULL) OR ((length(external_id) >= 1) AND (length(external_id) <= 512)))),
    CONSTRAINT auth_directory_user_name_valid CHECK ((((length(user_name) >= 1) AND (length(user_name) <= 320)) AND ((length(normalized_user_name) >= 1) AND (length(normalized_user_name) <= 320)))),
    CONSTRAINT auth_directory_user_profile_bounded CHECK (((jsonb_typeof(profile) = 'object'::text) AND (octet_length((profile)::text) <= 16384))),
    CONSTRAINT auth_directory_user_revision_positive CHECK ((revision > 0))
);


ALTER TABLE app.auth_directory_users OWNER TO pertexo_owner;

--
-- Name: auth_domains; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_domains (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    domain text NOT NULL,
    challenge text,
    challenge_expires_at timestamp with time zone,
    verified_at timestamp with time zone,
    require_sso boolean DEFAULT false NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT auth_domain_challenge_valid CHECK ((((challenge IS NULL) AND (challenge_expires_at IS NULL)) OR ((challenge IS NOT NULL) AND (challenge ~ '^[A-Za-z0-9_-]{43}$'::text) AND (challenge_expires_at IS NOT NULL)))),
    CONSTRAINT auth_domain_name_valid CHECK ((((length(domain) >= 3) AND (length(domain) <= 253)) AND (domain = lower(domain)))),
    CONSTRAINT auth_domain_revision_positive CHECK ((revision > 0))
);


ALTER TABLE app.auth_domains OWNER TO pertexo_owner;

--
-- Name: auth_email_proofs; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_email_proofs (
    id uuid NOT NULL,
    token_digest bytea NOT NULL,
    user_id uuid NOT NULL,
    purpose character varying(32) NOT NULL,
    email character varying(320) NOT NULL,
    new_email character varying(320),
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT auth_email_proof_digest_valid CHECK ((octet_length(token_digest) = 32)),
    CONSTRAINT auth_email_proof_expiry_valid CHECK ((expires_at > created_at)),
    CONSTRAINT auth_email_proof_new_email_valid CHECK (((((purpose)::text = 'initial_verification'::text) AND (new_email IS NULL)) OR (((purpose)::text = ANY (ARRAY[('change_old'::character varying)::text, ('change_new'::character varying)::text])) AND (new_email IS NOT NULL)))),
    CONSTRAINT auth_email_proof_purpose_valid CHECK (((purpose)::text = ANY (ARRAY[('initial_verification'::character varying)::text, ('change_old'::character varying)::text, ('change_new'::character varying)::text])))
);


ALTER TABLE app.auth_email_proofs OWNER TO pertexo_owner;

--
-- Name: auth_federation_attempts; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_federation_attempts (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    provider_revision integer NOT NULL,
    domain_id uuid NOT NULL,
    purpose text NOT NULL,
    owner_user_id uuid,
    owner_session_id uuid,
    state_digest bytea NOT NULL,
    browser_digest bytea NOT NULL,
    return_path text NOT NULL,
    request_id text,
    request_created_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT auth_federation_attempt_digest_valid CHECK (((octet_length(state_digest) = 32) AND (octet_length(browser_digest) = 32))),
    CONSTRAINT auth_federation_attempt_expiry_valid CHECK ((expires_at > created_at)),
    CONSTRAINT auth_federation_attempt_path_valid CHECK ((((length(return_path) >= 1) AND (length(return_path) <= 256)) AND ("left"(return_path, 1) = '/'::text))),
    CONSTRAINT auth_federation_attempt_purpose_valid CHECK ((((purpose = 'sign_in'::text) AND (owner_user_id IS NULL) AND (owner_session_id IS NULL)) OR ((purpose = 'test'::text) AND (owner_user_id IS NOT NULL) AND (owner_session_id IS NOT NULL)))),
    CONSTRAINT auth_federation_attempt_revision_positive CHECK ((provider_revision > 0))
);


ALTER TABLE app.auth_federation_attempts OWNER TO pertexo_owner;

--
-- Name: auth_method_link_attempts; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_method_link_attempts (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    browser_digest bytea NOT NULL,
    source_provider character varying(32) NOT NULL,
    target_provider character varying(32) NOT NULL,
    phase character varying(16) NOT NULL,
    state_digest bytea,
    expires_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT auth_method_link_browser_digest_valid CHECK ((octet_length(browser_digest) = 32)),
    CONSTRAINT auth_method_link_completion_valid CHECK ((((phase)::text = 'completed'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT auth_method_link_expiry_valid CHECK ((expires_at > created_at)),
    CONSTRAINT auth_method_link_phase_valid CHECK (((phase)::text = ANY (ARRAY[('source'::character varying)::text, ('target'::character varying)::text, ('completed'::character varying)::text, ('abandoned'::character varying)::text]))),
    CONSTRAINT auth_method_link_provider_valid CHECK ((((source_provider)::text = ANY (ARRAY[('credential'::character varying)::text, ('google'::character varying)::text, ('github'::character varying)::text, ('microsoft'::character varying)::text, ('apple'::character varying)::text])) AND ((target_provider)::text = ANY (ARRAY[('google'::character varying)::text, ('github'::character varying)::text, ('microsoft'::character varying)::text, ('apple'::character varying)::text])) AND ((source_provider)::text <> (target_provider)::text))),
    CONSTRAINT auth_method_link_state_digest_valid CHECK (((state_digest IS NULL) OR (octet_length(state_digest) = 32)))
);


ALTER TABLE app.auth_method_link_attempts OWNER TO pertexo_owner;

--
-- Name: auth_organization_workspaces; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_organization_workspaces (
    workspace_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    default_role text DEFAULT 'viewer'::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT auth_organization_workspace_role_valid CHECK ((default_role = ANY (ARRAY['viewer'::text, 'builder'::text, 'operator'::text, 'admin'::text])))
);


ALTER TABLE app.auth_organization_workspaces OWNER TO pertexo_owner;

--
-- Name: auth_organizations; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_organizations (
    id uuid NOT NULL,
    control_workspace_id uuid NOT NULL,
    name text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT auth_organization_name_valid CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 128))),
    CONSTRAINT auth_organization_revision_positive CHECK ((revision > 0))
);


ALTER TABLE app.auth_organizations OWNER TO pertexo_owner;

--
-- Name: auth_provider_checks; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_provider_checks (
    organization_id uuid NOT NULL,
    domain_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    provider_revision integer NOT NULL,
    tested_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT auth_provider_check_revision_positive CHECK ((provider_revision > 0))
);


ALTER TABLE app.auth_provider_checks OWNER TO pertexo_owner;

--
-- Name: auth_providers; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_providers (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    issuer text NOT NULL,
    configuration jsonb NOT NULL,
    sealed_secret jsonb,
    enabled boolean DEFAULT false NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT auth_provider_configuration_bounded CHECK (((jsonb_typeof(configuration) = 'object'::text) AND (octet_length((configuration)::text) <= 131072))),
    CONSTRAINT auth_provider_issuer_valid CHECK (((length(issuer) >= 1) AND (length(issuer) <= 2048))),
    CONSTRAINT auth_provider_kind_valid CHECK ((kind = ANY (ARRAY['oidc'::text, 'saml'::text]))),
    CONSTRAINT auth_provider_name_valid CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 128))),
    CONSTRAINT auth_provider_revision_positive CHECK ((revision > 0)),
    CONSTRAINT auth_provider_secret_bounded CHECK (((sealed_secret IS NULL) OR ((jsonb_typeof(sealed_secret) = 'object'::text) AND (octet_length((sealed_secret)::text) <= 32768)))),
    CONSTRAINT auth_provider_secret_presence_valid CHECK (((kind <> 'oidc'::text) OR (sealed_secret IS NOT NULL)))
);


ALTER TABLE app.auth_providers OWNER TO pertexo_owner;

--
-- Name: auth_provisioning_credentials; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_provisioning_credentials (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    secret_digest character(64) NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    CONSTRAINT auth_provisioning_credential_digest_valid CHECK ((secret_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT auth_provisioning_credential_name_valid CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 128)))
);


ALTER TABLE app.auth_provisioning_credentials OWNER TO pertexo_owner;

--
-- Name: auth_sessions; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_sessions (
    id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    ip_address text,
    user_agent text,
    user_id uuid NOT NULL,
    authentication_method text DEFAULT 'credential'::text NOT NULL,
    federation_provider_id uuid,
    federation_provider_revision integer,
    CONSTRAINT auth_session_authentication_proof_valid CHECK ((((authentication_method = ANY (ARRAY['credential'::text, 'social'::text])) AND (federation_provider_id IS NULL) AND (federation_provider_revision IS NULL)) OR ((authentication_method = 'organization'::text) AND (federation_provider_id IS NOT NULL) AND (federation_provider_revision IS NOT NULL) AND (federation_provider_revision > 0)))),
    CONSTRAINT auth_sessions_expiry_after_creation CHECK ((expires_at > created_at))
);


ALTER TABLE app.auth_sessions OWNER TO pertexo_owner;

--
-- Name: auth_sign_in_attempts; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_sign_in_attempts (
    id uuid NOT NULL,
    provider text NOT NULL,
    state_digest bytea NOT NULL,
    browser_digest bytea NOT NULL,
    return_path text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT auth_sign_in_digest_valid CHECK (((octet_length(state_digest) = 32) AND (octet_length(browser_digest) = 32))),
    CONSTRAINT auth_sign_in_expiry_valid CHECK ((expires_at > created_at)),
    CONSTRAINT auth_sign_in_path_valid CHECK ((((length(return_path) >= 1) AND (length(return_path) <= 128)) AND ("left"(return_path, 1) = '/'::text))),
    CONSTRAINT auth_sign_in_provider_valid CHECK ((provider ~ '^[a-z][a-z0-9_-]{0,31}$'::text))
);


ALTER TABLE app.auth_sign_in_attempts OWNER TO pertexo_owner;

--
-- Name: auth_two_factors; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_two_factors (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    secret text NOT NULL,
    backup_codes text NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    failed_verification_count integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


ALTER TABLE app.auth_two_factors OWNER TO pertexo_owner;

--
-- Name: auth_verifications; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.auth_verifications (
    id uuid NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


ALTER TABLE app.auth_verifications OWNER TO pertexo_owner;

--
-- Name: connection_events; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.connection_events (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    event_type character varying(64) NOT NULL,
    actor_kind character varying(32) NOT NULL,
    actor_id character varying(128) NOT NULL,
    request_id character varying(128),
    trace_id character varying(128),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT connection_events_actor_id_format CHECK (((actor_id)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'::text)),
    CONSTRAINT connection_events_actor_kind_valid CHECK (((actor_kind)::text = ANY (ARRAY[('user'::character varying)::text, ('worker'::character varying)::text, ('system'::character varying)::text]))),
    CONSTRAINT connection_events_metadata_bounded CHECK ((octet_length((metadata)::text) <= 4096)),
    CONSTRAINT connection_events_request_id_bounded CHECK (((request_id IS NULL) OR ((length((request_id)::text) >= 1) AND (length((request_id)::text) <= 128)))),
    CONSTRAINT connection_events_trace_id_bounded CHECK (((trace_id IS NULL) OR ((length((trace_id)::text) >= 1) AND (length((trace_id)::text) <= 128)))),
    CONSTRAINT connection_events_type_valid CHECK (((event_type)::text = ANY (ARRAY[('connection.created'::character varying)::text, ('connection.secret_rotated'::character varying)::text, ('connection.test_succeeded'::character varying)::text, ('connection.test_failed'::character varying)::text, ('connection.reauthorization_required'::character varying)::text, ('connection.revoked'::character varying)::text, ('connection.credential_accessed'::character varying)::text, ('connection.health_changed'::character varying)::text, ('connection.oauth2_authorized'::character varying)::text])))
);


ALTER TABLE app.connection_events OWNER TO pertexo_owner;

--
-- Name: connection_health_observations; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.connection_health_observations (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    kind character varying(32) NOT NULL,
    reason_code character varying(128),
    outbox_event_id uuid NOT NULL,
    observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    applied_at timestamp with time zone,
    CONSTRAINT connection_health_observations_signal_valid CHECK (((((kind)::text = 'healthy'::text) AND (reason_code IS NULL)) OR (((kind)::text = 'reauthorization_required'::text) AND (reason_code IS NOT NULL) AND ((reason_code)::text = ANY (ARRAY[('connection.slack_account_inactive'::character varying)::text, ('connection.slack_token_expired'::character varying)::text, ('connection.slack_token_revoked'::character varying)::text])))))
);


ALTER TABLE app.connection_health_observations OWNER TO pertexo_owner;

--
-- Name: connection_oauth2_authorizations; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.connection_oauth2_authorizations (
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    state_digest bytea NOT NULL,
    binding_digest bytea NOT NULL,
    started_by uuid NOT NULL,
    secret_version_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT connection_oauth2_authorizations_binding_digest_size CHECK ((octet_length(binding_digest) = 32)),
    CONSTRAINT connection_oauth2_authorizations_state_digest_size CHECK ((octet_length(state_digest) = 32))
);


ALTER TABLE app.connection_oauth2_authorizations OWNER TO pertexo_owner;

--
-- Name: connection_oauth2_clients; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.connection_oauth2_clients (
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    secret_version_id uuid NOT NULL,
    settings jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT connection_oauth2_clients_settings_bounded CHECK ((octet_length((settings)::text) <= 16384))
);


ALTER TABLE app.connection_oauth2_clients OWNER TO pertexo_owner;

--
-- Name: connection_oauth2_tokens; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.connection_oauth2_tokens (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    secret_version_id uuid NOT NULL,
    kms_key_reference character varying(2048) NOT NULL,
    encrypted_data_key text NOT NULL,
    ciphertext text NOT NULL,
    nonce character varying(64) NOT NULL,
    auth_tag character varying(64) NOT NULL,
    authorized_at timestamp with time zone NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    access_token_expires_at timestamp with time zone,
    renewable boolean NOT NULL,
    refresh_blocked_until timestamp with time zone,
    CONSTRAINT connection_oauth2_tokens_ciphertext_bounded CHECK (((length(ciphertext) >= 1) AND (length(ciphertext) <= 87382) AND (ciphertext ~ '^[A-Za-z0-9_-]+$'::text))),
    CONSTRAINT connection_oauth2_tokens_encrypted_key_bounded CHECK (((length(encrypted_data_key) >= 1) AND (length(encrypted_data_key) <= 10923) AND (encrypted_data_key ~ '^[A-Za-z0-9_-]+$'::text))),
    CONSTRAINT connection_oauth2_tokens_kms_reference_bounded CHECK (((length((kms_key_reference)::text) >= 1) AND (length((kms_key_reference)::text) <= 2048))),
    CONSTRAINT connection_oauth2_tokens_nonce_valid CHECK (((length((nonce)::text) = 16) AND ((nonce)::text ~ '^[A-Za-z0-9_-]+$'::text))),
    CONSTRAINT connection_oauth2_tokens_tag_valid CHECK (((length((auth_tag)::text) = 22) AND ((auth_tag)::text ~ '^[A-Za-z0-9_-]+$'::text)))
);


ALTER TABLE app.connection_oauth2_tokens OWNER TO pertexo_owner;

--
-- Name: connection_secret_versions; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.connection_secret_versions (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    kms_key_reference character varying(2048) NOT NULL,
    encrypted_data_key text NOT NULL,
    ciphertext text NOT NULL,
    nonce character varying(64) NOT NULL,
    auth_tag character varying(64) NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT connection_secret_versions_ciphertext_bounded CHECK (((length(ciphertext) >= 1) AND (length(ciphertext) <= 87382) AND (ciphertext ~ '^[A-Za-z0-9_-]+$'::text))),
    CONSTRAINT connection_secret_versions_encrypted_key_bounded CHECK (((length(encrypted_data_key) >= 1) AND (length(encrypted_data_key) <= 10923) AND (encrypted_data_key ~ '^[A-Za-z0-9_-]+$'::text))),
    CONSTRAINT connection_secret_versions_kms_reference_bounded CHECK (((length((kms_key_reference)::text) >= 1) AND (length((kms_key_reference)::text) <= 2048))),
    CONSTRAINT connection_secret_versions_nonce_valid CHECK (((length((nonce)::text) = 16) AND ((nonce)::text ~ '^[A-Za-z0-9_-]+$'::text))),
    CONSTRAINT connection_secret_versions_tag_valid CHECK (((length((auth_tag)::text) = 22) AND ((auth_tag)::text ~ '^[A-Za-z0-9_-]+$'::text)))
);


ALTER TABLE app.connection_secret_versions OWNER TO pertexo_owner;

--
-- Name: connection_shares; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.connection_shares (
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    user_id uuid NOT NULL
);


ALTER TABLE app.connection_shares OWNER TO pertexo_owner;

--
-- Name: connections; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.connections (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    provider_key character varying(64) NOT NULL,
    name character varying(128) NOT NULL,
    auth_type character varying(64) NOT NULL,
    status character varying(32) NOT NULL,
    current_secret_version_id uuid NOT NULL,
    last_tested_at timestamp with time zone,
    last_healthy_at timestamp with time zone,
    last_error_code character varying(128),
    health_revision bigint DEFAULT 1 NOT NULL,
    last_run_observed_at timestamp with time zone,
    last_health_transition_at timestamp with time zone,
    last_health_transition_source character varying(16),
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    access_mode character varying(16) DEFAULT 'workspace'::character varying NOT NULL,
    sharing_revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT connections_access_mode_valid CHECK (((access_mode)::text = ANY ((ARRAY['workspace'::character varying, 'restricted'::character varying])::text[]))),
    CONSTRAINT connections_auth_type_valid CHECK (((auth_type)::text = ANY (ARRAY[('hmac_key'::character varying)::text, ('http_headers'::character varying)::text, ('slack_bot_token'::character varying)::text, ('resend_api_key'::character varying)::text, ('smtp'::character varying)::text, ('oauth2'::character varying)::text]))),
    CONSTRAINT connections_error_code_format CHECK (((last_error_code IS NULL) OR ((last_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT connections_health_revision_positive CHECK ((health_revision > 0)),
    CONSTRAINT connections_health_transition_source_valid CHECK (((((last_health_transition_at IS NULL) AND (last_health_transition_source IS NULL)) OR ((last_health_transition_at IS NOT NULL) AND ((last_health_transition_source)::text = ANY (ARRAY[('run'::character varying)::text, ('test'::character varying)::text, ('rotation'::character varying)::text, ('revoke'::character varying)::text])))) IS TRUE)),
    CONSTRAINT connections_name_bounded CHECK ((((name)::text = btrim((name)::text)) AND ((length((name)::text) >= 1) AND (length((name)::text) <= 128)))),
    CONSTRAINT connections_provider_key_format CHECK (((provider_key)::text ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'::text)),
    CONSTRAINT connections_sharing_revision_positive CHECK ((sharing_revision > 0)),
    CONSTRAINT connections_status_valid CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('reauthorization_required'::character varying)::text, ('revoked'::character varying)::text])))
);


ALTER TABLE app.connections OWNER TO pertexo_owner;

--
-- Name: data_table_write_receipts; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.data_table_write_receipts (
    workspace_id uuid NOT NULL,
    execution_id uuid NOT NULL,
    invocation_id uuid NOT NULL,
    run_id uuid,
    preview_run_id uuid,
    request_hash character varying(64) NOT NULL,
    result_json text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT data_table_receipts_bounds CHECK ((((run_id IS NULL) <> (preview_run_id IS NULL)) AND (execution_id = COALESCE(run_id, preview_run_id)) AND ((request_hash)::text ~ '^[0-9a-f]{64}$'::text) AND (octet_length(result_json) <= 1048576)))
);


ALTER TABLE app.data_table_write_receipts OWNER TO pertexo_owner;

--
-- Name: failure_notification_destination_versions; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.failure_notification_destination_versions (
    workspace_id uuid NOT NULL,
    destination_id uuid CONSTRAINT failure_notification_destination_versio_destination_id_not_null NOT NULL,
    version integer NOT NULL,
    kind character varying(16) NOT NULL,
    side_effect_class character varying(32) CONSTRAINT failure_notification_destination_ver_side_effect_class_not_null NOT NULL,
    config jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT failure_notification_destination_versions_config_strict CHECK ((((jsonb_typeof(config) = 'object'::text) AND ((((kind)::text = 'system_mail'::text) AND (jsonb_typeof((config -> 'memberId'::text)) = 'string'::text) AND ((config - 'memberId'::text) = '{}'::jsonb) AND ((config ->> 'memberId'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)) OR (((kind)::text = 'slack'::text) AND (jsonb_typeof((config -> 'connectionId'::text)) = 'string'::text) AND (jsonb_typeof((config -> 'channelId'::text)) = 'string'::text) AND (((config - 'connectionId'::text) - 'channelId'::text) = '{}'::jsonb) AND ((config ->> 'connectionId'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((config ->> 'channelId'::text) ~ '^[CDGU][A-Z0-9]{1,79}$'::text)) OR (((kind)::text = 'email'::text) AND (jsonb_typeof((config -> 'connectionId'::text)) = 'string'::text) AND (jsonb_typeof((config -> 'toEmail'::text)) = 'string'::text) AND (((config - 'connectionId'::text) - 'toEmail'::text) = '{}'::jsonb) AND ((config ->> 'connectionId'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((length((config ->> 'toEmail'::text)) >= 3) AND (length((config ->> 'toEmail'::text)) <= 254)) AND ((config ->> 'toEmail'::text) ~ '^[!-~]+@[A-Za-z0-9.-]+$'::text)))) IS TRUE)),
    CONSTRAINT failure_notification_destination_versions_kind_valid CHECK (((kind)::text = ANY (ARRAY[('slack'::character varying)::text, ('email'::character varying)::text, ('system_mail'::character varying)::text]))),
    CONSTRAINT failure_notification_destination_versions_side_effect_valid CHECK (((((kind)::text = 'system_mail'::text) AND ((side_effect_class)::text = 'idempotent_with_key'::text)) OR (((kind)::text = 'slack'::text) AND ((side_effect_class)::text = 'unsafe'::text)) OR (((kind)::text = 'email'::text) AND ((side_effect_class)::text = ANY (ARRAY['idempotent_with_key'::text, 'unsafe'::text]))))),
    CONSTRAINT failure_notification_destination_versions_version_positive CHECK ((version > 0))
);


ALTER TABLE app.failure_notification_destination_versions OWNER TO pertexo_owner;

--
-- Name: failure_notification_destinations; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.failure_notification_destinations (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    kind character varying(16) NOT NULL,
    status character varying(16) DEFAULT 'enabled'::character varying NOT NULL,
    current_config_version integer DEFAULT 1 CONSTRAINT failure_notification_destinatio_current_config_version_not_null NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT failure_notification_destinations_kind_valid CHECK (((kind)::text = ANY (ARRAY[('slack'::character varying)::text, ('email'::character varying)::text, ('system_mail'::character varying)::text]))),
    CONSTRAINT failure_notification_destinations_status_valid CHECK (((status)::text = ANY (ARRAY[('enabled'::character varying)::text, ('disabled'::character varying)::text]))),
    CONSTRAINT failure_notification_destinations_version_positive CHECK ((current_config_version > 0))
);


ALTER TABLE app.failure_notification_destinations OWNER TO pertexo_owner;

--
-- Name: form_uploads; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.form_uploads (
    workspace_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    workflow_version_id uuid,
    task_id uuid,
    field_id character varying(64) NOT NULL,
    filename character varying(255) NOT NULL,
    session_hash character(64) NOT NULL,
    capability_hash character(64),
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    submitted_at timestamp with time zone,
    CONSTRAINT form_uploads_hashes_valid CHECK (((session_hash ~ '^[0-9a-f]{64}$'::text) AND ((capability_hash IS NULL) OR (capability_hash ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT form_uploads_responder_valid CHECK ((((capability_hash IS NULL) <> (uploaded_by IS NULL)) AND ((capability_hash IS NULL) OR (task_id IS NULL)))),
    CONSTRAINT form_uploads_target_valid CHECK (((workflow_version_id IS NULL) <> (task_id IS NULL)))
);


ALTER TABLE app.form_uploads OWNER TO pertexo_owner;

--
-- Name: idempotency_records; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.idempotency_records (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    operation character varying(64) NOT NULL,
    scope character varying(128) NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) NOT NULL,
    status character varying(16) NOT NULL,
    resource_id uuid NOT NULL,
    result_ref jsonb NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '24:00:00'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT idempotency_records_expiry_valid CHECK (((expires_at IS NULL) OR (expires_at > created_at))),
    CONSTRAINT idempotency_records_key_hash_format CHECK ((key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT idempotency_records_operation_format CHECK (((operation)::text ~ '^[a-z][a-z0-9.]{0,63}$'::text)),
    CONSTRAINT idempotency_records_request_hash_format CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT idempotency_records_result_ref_bounded CHECK ((octet_length((result_ref)::text) <= 196608)),
    CONSTRAINT idempotency_records_scope_format CHECK (((scope)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT idempotency_records_status_valid CHECK (((status)::text = ANY (ARRAY[('in_progress'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text])))
);


ALTER TABLE app.idempotency_records OWNER TO pertexo_owner;

--
-- Name: identity_security_audit_facts; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.identity_security_audit_facts (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    event_type character varying(64) NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT identity_security_audit_event_valid CHECK (((event_type)::text = ANY (ARRAY['email.initial_verified'::text, 'email.old_confirmed'::text, 'email.change_verified'::text, 'method.linked'::text, 'method.unlinked'::text, 'password.changed'::text, 'password.configured'::text, 'password.reset'::text, 'profile.display_name_changed'::text, 'session.signed_in'::text, 'two_factor.disabled'::text, 'two_factor.recovery_code_used'::text, 'two_factor.operator_disabled'::text])))
);


ALTER TABLE app.identity_security_audit_facts OWNER TO pertexo_owner;

--
-- Name: inbox_receipts; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.inbox_receipts (
    consumer_name character varying(128) NOT NULL,
    message_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    payload_checksum character(64) NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT inbox_receipts_checksum_format CHECK ((payload_checksum ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT inbox_receipts_completion_order CHECK (((completed_at IS NULL) OR (completed_at >= received_at))),
    CONSTRAINT inbox_receipts_consumer_name_format CHECK (((consumer_name)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))
)
WITH (autovacuum_vacuum_scale_factor='0.02', autovacuum_analyze_scale_factor='0.01', autovacuum_vacuum_insert_scale_factor='0.02');


ALTER TABLE app.inbox_receipts OWNER TO pertexo_owner;

--
-- Name: instance_capacity; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.instance_capacity (
    singleton boolean DEFAULT true NOT NULL,
    active_run_limit integer NOT NULL,
    queued_run_limit integer NOT NULL,
    artifact_count_limit integer NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    pending_task_limit integer DEFAULT 10000 NOT NULL,
    CONSTRAINT instance_capacity_limits_valid CHECK ((((active_run_limit >= 1) AND (active_run_limit <= 10000)) AND ((queued_run_limit >= 1) AND (queued_run_limit <= 100000)) AND (artifact_count_limit >= 0))),
    CONSTRAINT instance_capacity_pending_task_limit_valid CHECK (((pending_task_limit >= 1) AND (pending_task_limit <= 1000000))),
    CONSTRAINT instance_capacity_singleton CHECK (singleton)
);


ALTER TABLE app.instance_capacity OWNER TO pertexo_owner;

--
-- Name: node_attempt_connection_dispatches; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.node_attempt_connection_dispatches (
    workspace_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    provider_key character varying(64) NOT NULL,
    auth_type character varying(64) NOT NULL,
    secret_version_id uuid NOT NULL,
    health_revision bigint NOT NULL,
    worker_id character varying(128) NOT NULL,
    fence_token bigint NOT NULL,
    CONSTRAINT node_attempt_connection_dispatches_auth_type_check CHECK (((auth_type)::text = 'slack_bot_token'::text)),
    CONSTRAINT node_attempt_connection_dispatches_fence_token_check CHECK ((fence_token > 0)),
    CONSTRAINT node_attempt_connection_dispatches_health_revision_check CHECK ((health_revision > 0)),
    CONSTRAINT node_attempt_connection_dispatches_provider_key_check CHECK (((provider_key)::text = 'slack'::text))
);


ALTER TABLE app.node_attempt_connection_dispatches OWNER TO pertexo_owner;

--
-- Name: node_attempts; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.node_attempts (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    node_run_id uuid NOT NULL,
    attempt_number integer NOT NULL,
    status character varying(32) NOT NULL,
    side_effect_class character varying(32) NOT NULL,
    provider_idempotency_key character varying(256),
    lease_owner character varying(128),
    lease_expires_at timestamp with time zone,
    fence_token bigint DEFAULT 0 NOT NULL,
    dispatch_marked_at timestamp with time zone,
    output_ref json,
    safe_error_code character varying(128),
    error_summary character varying(2048),
    executor_failure_kind character varying(32),
    executor_error_kind character varying(32),
    executor_possibly_dispatched boolean,
    retry_decision character varying(32),
    admission_kind character varying(32) DEFAULT 'execute'::character varying NOT NULL,
    reconciliation_ref jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    code_diagnostics jsonb,
    executor_retry_after_millis integer,
    CONSTRAINT node_attempts_admission_kind_valid CHECK (((admission_kind)::text = ANY (ARRAY[('execute'::character varying)::text, ('retry'::character varying)::text, ('wait_resume'::character varying)::text]))),
    CONSTRAINT node_attempts_code_diagnostics_bound CHECK (((code_diagnostics IS NULL) OR ((jsonb_typeof(code_diagnostics) = 'object'::text) AND (octet_length((code_diagnostics)::text) <= 1048576)))),
    CONSTRAINT node_attempts_executor_error_kind_valid CHECK (((executor_error_kind IS NULL) OR ((executor_error_kind)::text = ANY (ARRAY[('authentication'::character varying)::text, ('canceled'::character varying)::text, ('configuration'::character varying)::text, ('internal'::character varying)::text, ('network'::character varying)::text, ('provider'::character varying)::text, ('rate_limit'::character varying)::text, ('timeout'::character varying)::text])))),
    CONSTRAINT node_attempts_executor_failure_complete CHECK ((((executor_failure_kind IS NULL) AND (executor_error_kind IS NULL) AND (executor_possibly_dispatched IS NULL) AND (retry_decision IS NULL)) OR ((executor_failure_kind IS NOT NULL) AND (executor_error_kind IS NOT NULL) AND (executor_possibly_dispatched IS NOT NULL) AND (retry_decision IS NOT NULL)))),
    CONSTRAINT node_attempts_executor_failure_kind_valid CHECK (((executor_failure_kind IS NULL) OR ((executor_failure_kind)::text = ANY (ARRAY[('failed'::character varying)::text, ('canceled'::character varying)::text, ('retry'::character varying)::text, ('outcome_unknown'::character varying)::text])))),
    CONSTRAINT node_attempts_executor_failure_only_failed CHECK (((executor_failure_kind IS NULL) OR ((status)::text = 'failed'::text))),
    CONSTRAINT node_attempts_executor_retry_after_valid CHECK (((executor_retry_after_millis IS NULL) OR ((executor_failure_kind IS NOT NULL) AND ((executor_retry_after_millis >= 0) AND (executor_retry_after_millis <= 60000))))),
    CONSTRAINT node_attempts_fence_nonnegative CHECK ((fence_token >= 0)),
    CONSTRAINT node_attempts_lease_complete CHECK ((((lease_owner IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND ((status)::text = 'running'::text)))),
    CONSTRAINT node_attempts_number_positive CHECK ((attempt_number > 0)),
    CONSTRAINT node_attempts_provider_key_valid CHECK ((((side_effect_class)::text = 'idempotent_with_key'::text) = (provider_idempotency_key IS NOT NULL))),
    CONSTRAINT node_attempts_reconciliation_ref_bounded CHECK (((reconciliation_ref IS NULL) OR (octet_length((reconciliation_ref)::text) <= 4096))),
    CONSTRAINT node_attempts_retry_decision_valid CHECK (((retry_decision IS NULL) OR ((retry_decision)::text = ANY (ARRAY[('pending'::character varying)::text, ('retry'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text])))),
    CONSTRAINT node_attempts_side_effect_class_valid CHECK (((side_effect_class)::text = ANY (ARRAY[('safe'::character varying)::text, ('idempotent_with_key'::character varying)::text, ('unsafe'::character varying)::text]))),
    CONSTRAINT node_attempts_status_valid CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('ready'::character varying)::text, ('running'::character varying)::text, ('waiting'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('skipped'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text])))
)
WITH (autovacuum_vacuum_scale_factor='0.02', autovacuum_analyze_scale_factor='0.01', autovacuum_vacuum_insert_scale_factor='0.02');


ALTER TABLE app.node_attempts OWNER TO pertexo_owner;

--
-- Name: node_runs; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.node_runs (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_run_id uuid NOT NULL,
    node_id character varying(128) NOT NULL,
    invocation_key character varying(256) NOT NULL,
    branch_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(32) NOT NULL,
    side_effect_class character varying(32) NOT NULL,
    provider_idempotency_key character varying(256),
    provider_dispatch_binding character varying(128),
    input_ref json,
    output_ref json,
    current_attempt_id uuid,
    current_attempt_number integer,
    resume_at timestamp with time zone,
    retry_due_at timestamp with time zone,
    due_wakeup_at timestamp with time zone,
    control_kind character varying(32),
    wait_kind character varying(32),
    safe_error_code character varying(128),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    reused_source_run_id uuid,
    reused_source_node_run_id uuid,
    reused_source_completed_at timestamp with time zone,
    failure_ref json,
    failure_handler_entry_key character varying(256),
    failure_handler_sink_key character varying(256),
    failure_handling character varying(16),
    CONSTRAINT node_runs_attempt_pointer_complete CHECK ((((current_attempt_id IS NULL) AND (current_attempt_number IS NULL)) OR ((current_attempt_id IS NOT NULL) AND (current_attempt_number IS NOT NULL) AND (current_attempt_number > 0)))),
    CONSTRAINT node_runs_branch_context_bounded CHECK ((octet_length((branch_context)::text) <= 4096)),
    CONSTRAINT node_runs_control_kind_valid CHECK (((control_kind IS NULL) OR ((control_kind)::text = ANY (ARRAY['for_each_barrier'::text, 'workflow_call'::text, 'human_task'::text])))),
    CONSTRAINT node_runs_due_wakeup_consistent CHECK ((((due_wakeup_at IS NULL) OR (((status)::text = 'waiting'::text) AND (COALESCE(retry_due_at, resume_at) IS NOT NULL) AND (due_wakeup_at = COALESCE(retry_due_at, resume_at)))) IS TRUE)),
    CONSTRAINT node_runs_failure_handling_complete CHECK (((((failure_ref IS NULL) AND (failure_handler_entry_key IS NULL) AND (failure_handler_sink_key IS NULL) AND (failure_handling IS NULL)) OR ((failure_ref IS NOT NULL) AND (failure_handler_entry_key IS NOT NULL) AND (failure_handler_sink_key IS NOT NULL) AND ((failure_handling)::text = ANY (ARRAY[('pending'::character varying)::text, ('handled'::character varying)::text])) AND ((status)::text = 'failed'::text) AND (current_attempt_id IS NOT NULL) AND (current_attempt_number > 0))) IS TRUE)),
    CONSTRAINT node_runs_failure_ref_bounded CHECK (((failure_ref IS NULL) OR (octet_length((failure_ref)::text) <= 4096))),
    CONSTRAINT node_runs_invocation_key_format CHECK ((((invocation_key)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$'::text) OR ((invocation_key)::text ~ '^([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})+\|([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})+\|b:([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})*\|i:([A-Za-z0-9_.!~*()''-]|%[0-9A-F]{2})*$'::text))),
    CONSTRAINT node_runs_node_id_format CHECK (((node_id)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT node_runs_provider_dispatch_binding_format CHECK (((provider_dispatch_binding IS NULL) OR ((provider_dispatch_binding)::text ~ '^[a-z][a-z0-9._-]{0,31}:sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT node_runs_provider_key_bounded CHECK (((provider_idempotency_key IS NULL) OR (length((provider_idempotency_key)::text) <= 256))),
    CONSTRAINT node_runs_provider_key_valid CHECK ((((side_effect_class)::text = 'idempotent_with_key'::text) = (provider_idempotency_key IS NOT NULL))),
    CONSTRAINT node_runs_reuse_provenance_complete CHECK (((((reused_source_run_id IS NULL) AND (reused_source_node_run_id IS NULL) AND (reused_source_completed_at IS NULL)) OR ((reused_source_run_id IS NOT NULL) AND (reused_source_node_run_id IS NOT NULL) AND (reused_source_completed_at IS NOT NULL) AND ((status)::text = 'succeeded'::text) AND (output_ref IS NOT NULL) AND (current_attempt_id IS NULL) AND (current_attempt_number IS NULL) AND (started_at IS NULL) AND (completed_at IS NULL) AND (control_kind IS NULL) AND (provider_dispatch_binding IS NULL) AND (input_ref IS NULL))) IS TRUE)),
    CONSTRAINT node_runs_side_effect_class_valid CHECK (((side_effect_class)::text = ANY (ARRAY[('safe'::character varying)::text, ('idempotent_with_key'::character varying)::text, ('unsafe'::character varying)::text]))),
    CONSTRAINT node_runs_status_valid CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('ready'::character varying)::text, ('running'::character varying)::text, ('waiting'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('skipped'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text]))),
    CONSTRAINT node_runs_wait_kind_valid CHECK (((wait_kind IS NULL) OR ((wait_kind)::text = ANY (ARRAY[('node_wait'::character varying)::text, ('retry_backoff'::character varying)::text])))),
    CONSTRAINT node_runs_wait_state_valid CHECK ((((((status)::text = 'waiting'::text) AND ((control_kind)::text = ANY (ARRAY['for_each_barrier'::text, 'workflow_call'::text])) AND (wait_kind IS NULL) AND (resume_at IS NULL) AND (retry_due_at IS NULL)) OR (((status)::text = 'waiting'::text) AND ((control_kind)::text = 'human_task'::text) AND (wait_kind IS NULL) AND (resume_at IS NOT NULL) AND (retry_due_at IS NULL)) OR (((status)::text = 'waiting'::text) AND (control_kind IS NULL) AND ((((wait_kind)::text = 'node_wait'::text) AND (resume_at IS NOT NULL) AND (retry_due_at IS NULL)) OR (((wait_kind)::text = 'retry_backoff'::text) AND (resume_at IS NULL) AND (retry_due_at IS NOT NULL)))) OR (((status)::text <> 'waiting'::text) AND (control_kind IS NULL) AND (wait_kind IS NULL) AND (resume_at IS NULL) AND (retry_due_at IS NULL))) IS TRUE))
)
WITH (autovacuum_vacuum_scale_factor='0.02', autovacuum_analyze_scale_factor='0.01', autovacuum_vacuum_insert_scale_factor='0.02');


ALTER TABLE app.node_runs OWNER TO pertexo_owner;

--
-- Name: notice_mail_batches; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.notice_mail_batches (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    preference_revision integer NOT NULL,
    default_revision integer NOT NULL,
    member_revision integer NOT NULL,
    recipient character varying(320) NOT NULL,
    window_key character varying(64) NOT NULL,
    item_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    released_at timestamp with time zone,
    CONSTRAINT notice_mail_batches_valid CHECK (((preference_revision >= 0) AND (default_revision >= 0) AND (member_revision > 0) AND ((item_count >= 1) AND (item_count <= 100))))
);


ALTER TABLE app.notice_mail_batches OWNER TO pertexo_owner;

--
-- Name: notice_mail_items; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.notice_mail_items (
    workspace_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    revision bigint NOT NULL,
    CONSTRAINT notice_mail_items_revision_valid CHECK ((revision > 0))
);


ALTER TABLE app.notice_mail_items OWNER TO pertexo_owner;

--
-- Name: notice_preferences; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.notice_preferences (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    mode character varying(16),
    hour integer DEFAULT 9 NOT NULL,
    time_zone character varying(128) DEFAULT 'UTC'::character varying NOT NULL,
    changed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    next_due_at timestamp with time zone,
    schedule_default_revision integer DEFAULT 0 NOT NULL,
    CONSTRAINT notice_preferences_valid CHECK (((revision >= 0) AND ((mode IS NULL) OR ((mode)::text = ANY ((ARRAY['off'::character varying, 'immediate'::character varying, 'hourly'::character varying, 'daily'::character varying])::text[]))) AND ((hour >= 0) AND (hour <= 23)) AND (schedule_default_revision >= 0)))
);


ALTER TABLE app.notice_preferences OWNER TO pertexo_owner;

--
-- Name: notice_subscriptions; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.notice_subscriptions (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    subject_kind character varying(16) NOT NULL,
    subject_id uuid NOT NULL,
    workflow_id uuid,
    connection_id uuid,
    revision integer DEFAULT 0 NOT NULL,
    followed boolean DEFAULT false NOT NULL,
    muted boolean DEFAULT false NOT NULL,
    changed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT notice_subscriptions_valid CHECK (((revision >= 0) AND (((((subject_kind)::text = 'workflow'::text) AND (workflow_id = subject_id) AND (connection_id IS NULL)) OR (((subject_kind)::text = 'connection'::text) AND (connection_id = subject_id) AND (workflow_id IS NULL) AND (NOT followed))) IS TRUE)))
);


ALTER TABLE app.notice_subscriptions OWNER TO pertexo_owner;

--
-- Name: notice_workspace_settings; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.notice_workspace_settings (
    workspace_id uuid NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    mode character varying(16) DEFAULT 'off'::character varying NOT NULL,
    hour integer DEFAULT 9 NOT NULL,
    time_zone character varying(128) DEFAULT 'UTC'::character varying NOT NULL,
    changed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT notice_workspace_settings_valid CHECK (((revision >= 0) AND ((mode)::text = ANY ((ARRAY['off'::character varying, 'immediate'::character varying, 'hourly'::character varying, 'daily'::character varying])::text[])) AND ((hour >= 0) AND (hour <= 23))))
);


ALTER TABLE app.notice_workspace_settings OWNER TO pertexo_owner;

--
-- Name: operator_commands; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.operator_commands (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    command_type character varying(64) NOT NULL,
    dry_run boolean NOT NULL,
    request_fingerprint character(64) NOT NULL,
    status character varying(16) NOT NULL,
    outcome character varying(32) NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone DEFAULT clock_timestamp(),
    result jsonb NOT NULL,
    CONSTRAINT operator_commands_completion_order CHECK ((((((status)::text = 'pending'::text) AND (completed_at IS NULL)) OR (((status)::text = ANY (ARRAY[('completed'::character varying)::text, ('failed'::character varying)::text])) AND (completed_at IS NOT NULL) AND (completed_at >= created_at))) IS TRUE)),
    CONSTRAINT operator_commands_fingerprint_valid CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT operator_commands_outcome_valid CHECK (((outcome)::text ~ '^[a-z][a-z0-9_]{0,31}$'::text)),
    CONSTRAINT operator_commands_result_valid CHECK (((jsonb_typeof(result) = 'object'::text) AND (octet_length((result)::text) <= 16384))),
    CONSTRAINT operator_commands_status_valid CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text]))),
    CONSTRAINT operator_commands_type_valid CHECK (((command_type)::text = ANY (ARRAY[('outbox.redispatch'::character varying)::text, ('attempt.reconcile'::character varying)::text, ('due-work.resume'::character varying)::text, ('unknown-outcome.record-evidence'::character varying)::text, ('run.cancel'::character varying)::text, ('run.replay'::character varying)::text, ('trigger.reconcile'::character varying)::text])))
);


ALTER TABLE app.operator_commands OWNER TO pertexo_owner;

--
-- Name: operator_run_replay_requests; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.operator_run_replay_requests (
    command_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    source_run_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    workflow_version_id uuid NOT NULL,
    run_input json NOT NULL,
    request_fingerprint character(64) NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    result_run_id uuid,
    safe_error_code character varying(64),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT operator_run_replay_completion_valid CHECK (((((status)::text = 'pending'::text) AND (result_run_id IS NULL) AND (safe_error_code IS NULL) AND (completed_at IS NULL)) OR (((status)::text = 'completed'::text) AND (result_run_id IS NOT NULL) AND (safe_error_code IS NULL) AND (completed_at IS NOT NULL)) OR (((status)::text = 'failed'::text) AND (result_run_id IS NULL) AND (safe_error_code IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT operator_run_replay_fingerprint_valid CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT operator_run_replay_input_bounded CHECK ((octet_length((run_input)::text) <= 65536)),
    CONSTRAINT operator_run_replay_status_valid CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text])))
);


ALTER TABLE app.operator_run_replay_requests OWNER TO pertexo_owner;

--
-- Name: operator_unknown_outcome_evidence; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.operator_unknown_outcome_evidence (
    command_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    evidence_kind character varying(64) NOT NULL,
    evidence_ref jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT operator_unknown_evidence_kind_valid CHECK (((evidence_kind)::text ~ '^[a-z][a-z0-9_.-]{0,63}$'::text)),
    CONSTRAINT operator_unknown_evidence_ref_valid CHECK (((jsonb_typeof(evidence_ref) = 'object'::text) AND (octet_length((evidence_ref)::text) <= 4096)))
);


ALTER TABLE app.operator_unknown_outcome_evidence OWNER TO pertexo_owner;

--
-- Name: outbox_events; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.outbox_events (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    job_name character varying(128) NOT NULL,
    aggregate_type character varying(64) NOT NULL,
    aggregate_id uuid NOT NULL,
    payload jsonb NOT NULL,
    payload_checksum character(64) NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner character varying(128),
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    publish_attempts integer DEFAULT 0 NOT NULL,
    published_at timestamp with time zone,
    failed_at timestamp with time zone,
    last_error_code character varying(128),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    delivery_due_at timestamp with time zone,
    redeliveries integer DEFAULT 0 NOT NULL,
    CONSTRAINT outbox_events_aggregate_type_format CHECK (((aggregate_type)::text ~ '^[a-z][a-z0-9.-]{0,63}$'::text)),
    CONSTRAINT outbox_events_attempts_nonnegative CHECK ((publish_attempts >= 0)),
    CONSTRAINT outbox_events_checksum_format CHECK ((payload_checksum ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT outbox_events_error_code_format CHECK (((last_error_code IS NULL) OR ((last_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT outbox_events_job_name_format CHECK (((job_name)::text ~ '^[a-z][a-z0-9-]{0,127}$'::text)),
    CONSTRAINT outbox_events_lease_complete CHECK ((((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT outbox_events_lease_owner_format CHECK (((lease_owner IS NULL) OR ((lease_owner)::text ~ '^[A-Za-z0-9._:-]{1,128}$'::text))),
    CONSTRAINT outbox_events_payload_bounded CHECK ((octet_length((payload)::text) <= 4096)),
    CONSTRAINT outbox_events_redeliveries_nonnegative CHECK ((redeliveries >= 0)),
    CONSTRAINT outbox_events_terminal_state_exclusive CHECK ((NOT ((published_at IS NOT NULL) AND (failed_at IS NOT NULL))))
)
WITH (autovacuum_vacuum_scale_factor='0.02', autovacuum_analyze_scale_factor='0.01', autovacuum_vacuum_insert_scale_factor='0.02');


ALTER TABLE app.outbox_events OWNER TO pertexo_owner;

--
-- Name: outbox_fair_dispatch_cursor; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.outbox_fair_dispatch_cursor (
    singleton boolean DEFAULT true NOT NULL,
    last_workspace_id uuid,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT outbox_fair_dispatch_cursor_singleton_check CHECK (singleton)
);


ALTER TABLE app.outbox_fair_dispatch_cursor OWNER TO pertexo_owner;

--
-- Name: pending_run_tasks; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.pending_run_tasks (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    run_id uuid NOT NULL,
    workflow_version_id uuid NOT NULL,
    node_run_id uuid,
    invocation_key character varying(256) NOT NULL,
    kind character varying(32) NOT NULL,
    config jsonb NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    output_ref json,
    decided_by uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone,
    completed_at timestamp with time zone,
    consumed_at timestamp with time zone,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    callback_node_id character varying(64),
    callback_scope jsonb,
    callback_scope_hash character(64),
    callback_token_hash character(64),
    callback_key_version character varying(64),
    opened_at timestamp with time zone,
    CONSTRAINT pending_run_tasks_binding_valid CHECK ((((((kind)::text <> 'callback'::text) AND (node_run_id IS NOT NULL) AND (callback_node_id IS NULL) AND (callback_scope IS NULL) AND (callback_scope_hash IS NULL) AND (callback_token_hash IS NULL) AND (callback_key_version IS NULL) AND (opened_at IS NULL)) OR (((kind)::text = 'callback'::text) AND (((status)::text <> 'pending'::text) OR (node_run_id IS NOT NULL)) AND (callback_node_id IS NOT NULL) AND (jsonb_typeof(callback_scope) = 'array'::text) AND (octet_length((callback_scope)::text) <= 8192) AND (callback_scope_hash ~ '^[0-9a-f]{64}$'::text) AND (callback_token_hash ~ '^[0-9a-f]{64}$'::text) AND ((callback_key_version)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'::text) AND (((node_run_id IS NULL) AND (opened_at IS NULL)) OR ((node_run_id IS NOT NULL) AND (opened_at IS NOT NULL))))) IS TRUE)),
    CONSTRAINT pending_run_tasks_config_bounded CHECK (((jsonb_typeof(config) = 'object'::text) AND (octet_length((config)::text) <= 16384))),
    CONSTRAINT pending_run_tasks_context_bounded CHECK (((jsonb_typeof(context) = 'object'::text) AND (octet_length((context)::text) <= 73728))),
    CONSTRAINT pending_run_tasks_expiry_valid CHECK ((((((kind)::text <> 'callback'::text) AND (expires_at > created_at) AND (expires_at <= (created_at + '30 days'::interval))) OR (((kind)::text = 'callback'::text) AND (((opened_at IS NULL) AND (expires_at IS NULL)) OR ((opened_at IS NOT NULL) AND (expires_at > opened_at) AND (expires_at <= (opened_at + '30 days'::interval)))))) IS TRUE)),
    CONSTRAINT pending_run_tasks_kind_valid CHECK (((kind)::text = ANY ((ARRAY['approval'::character varying, 'input_request'::character varying, 'callback'::character varying])::text[]))),
    CONSTRAINT pending_run_tasks_result_kind_valid CHECK (((((status)::text <> ALL ((ARRAY['approved'::character varying, 'rejected'::character varying, 'submitted'::character varying])::text[])) OR (((kind)::text = 'approval'::text) AND ((status)::text = ANY ((ARRAY['approved'::character varying, 'rejected'::character varying])::text[]))) OR (((kind)::text = ANY ((ARRAY['input_request'::character varying, 'callback'::character varying])::text[])) AND ((status)::text = 'submitted'::text))) IS TRUE)),
    CONSTRAINT pending_run_tasks_state_valid CHECK ((((((kind)::text = 'callback'::text) AND ((status)::text = 'prepared'::text) AND (node_run_id IS NULL) AND (opened_at IS NULL) AND (output_ref IS NULL) AND (decided_by IS NULL) AND (completed_at IS NULL) AND (consumed_at IS NULL)) OR (((status)::text = 'pending'::text) AND (output_ref IS NULL) AND (decided_by IS NULL) AND (completed_at IS NULL) AND (consumed_at IS NULL)) OR (((status)::text = ANY ((ARRAY['approved'::character varying, 'rejected'::character varying, 'submitted'::character varying])::text[])) AND (output_ref IS NOT NULL) AND ((((kind)::text = 'callback'::text) AND (decided_by IS NULL)) OR (((kind)::text <> 'callback'::text) AND (decided_by IS NOT NULL))) AND (completed_at IS NOT NULL)) OR (((status)::text = 'expired'::text) AND ((kind)::text = ANY ((ARRAY['approval'::character varying, 'input_request'::character varying])::text[])) AND (output_ref IS NOT NULL) AND (decided_by IS NULL) AND (completed_at IS NOT NULL)) OR (((status)::text = ANY ((ARRAY['expired'::character varying, 'refused'::character varying, 'canceled'::character varying])::text[])) AND (output_ref IS NULL) AND (decided_by IS NULL) AND (completed_at IS NOT NULL))) IS TRUE))
);


ALTER TABLE app.pending_run_tasks OWNER TO pertexo_owner;

--
-- Name: preview_attempts; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.preview_attempts (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    preview_run_id uuid NOT NULL,
    status character varying(32) DEFAULT 'queued'::character varying NOT NULL,
    side_effect_class character varying(32) NOT NULL,
    provider_idempotency_key character varying(256),
    provider_dispatch_binding character varying(128),
    lease_owner character varying(128),
    lease_expires_at timestamp with time zone,
    fence_token bigint DEFAULT 0 NOT NULL,
    dispatch_marked_at timestamp with time zone,
    output_ref json,
    safe_error_code character varying(128),
    reconciliation_ref jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    code_diagnostics jsonb,
    error_summary character varying(2048),
    CONSTRAINT preview_attempts_code_diagnostics_bound CHECK (((code_diagnostics IS NULL) OR ((jsonb_typeof(code_diagnostics) = 'object'::text) AND (octet_length((code_diagnostics)::text) <= 1048576)))),
    CONSTRAINT preview_attempts_error_code_format CHECK (((safe_error_code IS NULL) OR ((safe_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT preview_attempts_fence_nonnegative CHECK ((fence_token >= 0)),
    CONSTRAINT preview_attempts_lease_complete CHECK ((((lease_owner IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT preview_attempts_lease_owner_format CHECK (((lease_owner IS NULL) OR ((lease_owner)::text ~ '^[A-Za-z0-9._:-]{1,128}$'::text))),
    CONSTRAINT preview_attempts_output_truth CHECK (((((status)::text = 'succeeded'::text) AND (output_ref IS NOT NULL) AND (safe_error_code IS NULL)) OR (((status)::text <> 'succeeded'::text) AND (output_ref IS NULL)))),
    CONSTRAINT preview_attempts_provider_dispatch_binding_format CHECK (((provider_dispatch_binding IS NULL) OR ((provider_dispatch_binding)::text ~ '^[a-z][a-z0-9._-]{0,31}:sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT preview_attempts_provider_key_bounded CHECK (((provider_idempotency_key IS NULL) OR ((length((provider_idempotency_key)::text) >= 1) AND (length((provider_idempotency_key)::text) <= 256)))),
    CONSTRAINT preview_attempts_reconciliation_bounded CHECK (((reconciliation_ref IS NULL) OR (octet_length((reconciliation_ref)::text) <= 4096))),
    CONSTRAINT preview_attempts_side_effect_class_valid CHECK (((side_effect_class)::text = ANY (ARRAY[('safe'::character varying)::text, ('idempotent_with_key'::character varying)::text, ('unsafe'::character varying)::text]))),
    CONSTRAINT preview_attempts_status_valid CHECK (((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text]))),
    CONSTRAINT preview_attempts_terminal_shape CHECK (((((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text])) AND (completed_at IS NULL)) OR (((status)::text = ANY (ARRAY[('succeeded'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text])) AND (completed_at IS NOT NULL)))),
    CONSTRAINT preview_attempts_time_order CHECK ((((started_at IS NULL) OR (started_at >= created_at)) AND ((completed_at IS NULL) OR (completed_at >= created_at)) AND ((completed_at IS NULL) OR (started_at IS NOT NULL)) AND ((dispatch_marked_at IS NULL) OR (started_at IS NOT NULL))))
);


ALTER TABLE app.preview_attempts OWNER TO pertexo_owner;

--
-- Name: preview_runs; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.preview_runs (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    draft_revision integer NOT NULL,
    draft_fingerprint character(64) NOT NULL,
    node_id character varying(256) NOT NULL,
    definition_key character varying(128) NOT NULL,
    definition_version integer NOT NULL,
    executor_key character varying(128) NOT NULL,
    executor_version integer NOT NULL,
    actor_user_id uuid NOT NULL,
    idempotency_key_hash character(64) NOT NULL,
    request_hash character(64) NOT NULL,
    request_id character varying(128),
    trace_id character varying(128),
    provider_key character varying(64),
    operation_key character varying(128),
    executable_node_json json NOT NULL,
    input_ref json NOT NULL,
    prior_preview_run_id uuid,
    side_effect_class character varying(32) NOT NULL,
    may_contact_provider boolean NOT NULL,
    may_cause_external_side_effect boolean NOT NULL,
    dry_run character varying(32) NOT NULL,
    status character varying(32) DEFAULT 'queued'::character varying NOT NULL,
    output_ref json,
    safe_error_code character varying(128),
    traceparent character varying(55),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    execution_deadline_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    variable_set_revision integer,
    pinned_sample_id uuid,
    CONSTRAINT preview_runs_definition_key_format CHECK (((definition_key)::text ~ '^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$'::text)),
    CONSTRAINT preview_runs_draft_fingerprint_format CHECK ((draft_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT preview_runs_dry_run_valid CHECK (((dry_run)::text = ANY (ARRAY[('not_supported'::character varying)::text, ('provider_supported'::character varying)::text]))),
    CONSTRAINT preview_runs_execution_deadline_order CHECK (((execution_deadline_at > created_at) AND (execution_deadline_at <= expires_at))),
    CONSTRAINT preview_runs_executor_key_format CHECK (((executor_key)::text ~ '^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$'::text)),
    CONSTRAINT preview_runs_idempotency_hashes_format CHECK (((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT preview_runs_integration_identity_consistent CHECK (((((provider_key IS NULL) AND (operation_key IS NULL)) OR ((provider_key IS NOT NULL) AND (operation_key IS NOT NULL) AND ((provider_key)::text ~ '^[a-z][a-z0-9._:-]{0,63}$'::text) AND ((operation_key)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))) IS TRUE)),
    CONSTRAINT preview_runs_node_id_bounded CHECK (((length((node_id)::text) >= 1) AND (length((node_id)::text) <= 256))),
    CONSTRAINT preview_runs_node_object CHECK ((json_typeof(executable_node_json) = 'object'::text)),
    CONSTRAINT preview_runs_output_truth CHECK (((((status)::text = 'succeeded'::text) AND (output_ref IS NOT NULL) AND (safe_error_code IS NULL)) OR (((status)::text <> 'succeeded'::text) AND (output_ref IS NULL)))),
    CONSTRAINT preview_runs_pinned_sample_valid CHECK (((pinned_sample_id IS NULL) OR (((status)::text = 'succeeded'::text) AND ((side_effect_class)::text = 'safe'::text) AND (may_contact_provider = false) AND (may_cause_external_side_effect = false) AND (started_at IS NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT preview_runs_retention_future CHECK ((expires_at > created_at)),
    CONSTRAINT preview_runs_revision_positive CHECK ((draft_revision > 0)),
    CONSTRAINT preview_runs_safe_error_code_format CHECK (((safe_error_code IS NULL) OR ((safe_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT preview_runs_side_effect_class_valid CHECK (((side_effect_class)::text = ANY (ARRAY[('safe'::character varying)::text, ('idempotent_with_key'::character varying)::text, ('unsafe'::character varying)::text]))),
    CONSTRAINT preview_runs_status_valid CHECK (((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text]))),
    CONSTRAINT preview_runs_terminal_shape CHECK (((((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text])) AND (completed_at IS NULL)) OR (((status)::text = ANY (ARRAY[('succeeded'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text])) AND (completed_at IS NOT NULL)))),
    CONSTRAINT preview_runs_time_order CHECK ((((started_at IS NULL) OR (started_at >= created_at)) AND ((completed_at IS NULL) OR (completed_at >= created_at)) AND ((completed_at IS NULL) OR (started_at IS NOT NULL) OR (pinned_sample_id IS NOT NULL)))),
    CONSTRAINT preview_runs_traceparent_format CHECK (((traceparent IS NULL) OR ((traceparent)::text ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'::text))),
    CONSTRAINT preview_runs_versions_positive CHECK (((definition_version > 0) AND (executor_version > 0)))
);


ALTER TABLE app.preview_runs OWNER TO pertexo_owner;

--
-- Name: run_checkpoints; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.run_checkpoints (
    workflow_run_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_version_id uuid NOT NULL,
    revision integer NOT NULL,
    scheduler_state jsonb NOT NULL,
    resume_at timestamp with time zone,
    resume_lease_owner character varying(128),
    resume_lease_token uuid,
    resume_lease_expires_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT run_checkpoints_resume_lease_complete CHECK ((((resume_lease_owner IS NULL) AND (resume_lease_token IS NULL) AND (resume_lease_expires_at IS NULL)) OR ((resume_lease_owner IS NOT NULL) AND (resume_lease_token IS NOT NULL) AND (resume_lease_expires_at IS NOT NULL)))),
    CONSTRAINT run_checkpoints_revision_nonnegative CHECK ((revision >= 0)),
    CONSTRAINT run_checkpoints_scheduler_state_bounded CHECK ((octet_length((scheduler_state)::text) <= 4194304))
)
WITH (autovacuum_vacuum_scale_factor='0.02', autovacuum_analyze_scale_factor='0.01', autovacuum_vacuum_insert_scale_factor='0.02');


ALTER TABLE app.run_checkpoints OWNER TO pertexo_owner;

--
-- Name: run_error_workflow_intents; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.run_error_workflow_intents (
    workspace_id uuid NOT NULL,
    source_run_id uuid NOT NULL,
    target_workflow_id uuid NOT NULL,
    target_version_id uuid,
    context jsonb NOT NULL,
    outbox_event_id uuid,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    accepted_run_id uuid,
    refusal_code character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    queue_wait_expires_at timestamp with time zone,
    CONSTRAINT run_error_workflow_intents_context_bounded CHECK (((jsonb_typeof(context) = 'object'::text) AND (octet_length((context)::text) <= 8192))),
    CONSTRAINT run_error_workflow_intents_state_valid CHECK ((((((status)::text = 'pending'::text) AND (accepted_run_id IS NULL) AND (refusal_code IS NULL) AND (completed_at IS NULL)) OR (((status)::text = 'accepted'::text) AND (accepted_run_id IS NOT NULL) AND (refusal_code IS NULL) AND (completed_at IS NOT NULL)) OR (((status)::text = 'refused'::text) AND (accepted_run_id IS NULL) AND ((refusal_code)::text = ANY ((ARRAY['target_unavailable'::character varying, 'workspace_unavailable'::character varying, 'queue_full'::character varying, 'invalid_target'::character varying, 'target_not_published'::character varying, 'concurrency_limit'::character varying])::text[])) AND (completed_at IS NOT NULL))) IS TRUE)),
    CONSTRAINT run_error_workflow_intents_target_valid CHECK ((
CASE
    WHEN ((refusal_code)::text = 'target_not_published'::text) THEN (((status)::text = 'refused'::text) AND (target_version_id IS NULL) AND (outbox_event_id IS NULL))
    ELSE ((target_version_id IS NOT NULL) AND (outbox_event_id IS NOT NULL))
END IS TRUE))
);


ALTER TABLE app.run_error_workflow_intents OWNER TO pertexo_owner;

--
-- Name: run_events; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.run_events (
    workspace_id uuid NOT NULL,
    workflow_run_id uuid NOT NULL,
    sequence integer NOT NULL,
    type character varying(64) NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT run_events_payload_bounded CHECK ((octet_length((payload)::text) <= 524288)),
    CONSTRAINT run_events_sequence_positive CHECK ((sequence > 0)),
    CONSTRAINT run_events_type_catalog CHECK (((type)::text = ANY (ARRAY[('run.queued'::character varying)::text, ('run.started'::character varying)::text, ('run.waiting'::character varying)::text, ('run.cancel_requested'::character varying)::text, ('run.succeeded'::character varying)::text, ('run.failed'::character varying)::text, ('run.canceled'::character varying)::text, ('run.timed_out'::character varying)::text, ('run.outcome_unknown'::character varying)::text, ('node.ready'::character varying)::text, ('node.reused'::character varying)::text, ('node.failure_routed'::character varying)::text, ('node.failure_handled'::character varying)::text, ('node.started'::character varying)::text, ('node.progress'::character varying)::text, ('node.waiting'::character varying)::text, ('node.retry_scheduled'::character varying)::text, ('node.succeeded'::character varying)::text, ('node.failed'::character varying)::text, ('node.skipped'::character varying)::text, ('node.canceled'::character varying)::text, ('node.timed_out'::character varying)::text, ('node.outcome_unknown'::character varying)::text])))
)
WITH (autovacuum_vacuum_scale_factor='0.02', autovacuum_analyze_scale_factor='0.01', autovacuum_vacuum_insert_scale_factor='0.02');


ALTER TABLE app.run_events OWNER TO pertexo_owner;

--
-- Name: run_failure_notification_audit_facts; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.run_failure_notification_audit_facts (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    notification_intent_id uuid CONSTRAINT run_failure_notification_audit__notification_intent_id_not_null NOT NULL,
    fact_type character varying(64) NOT NULL,
    attempt_number integer NOT NULL,
    safe_error_code character varying(128),
    possibly_dispatched boolean CONSTRAINT run_failure_notification_audit_fac_possibly_dispatched_not_null NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT run_failure_notification_audit_attempt_nonnegative CHECK ((attempt_number >= 0)),
    CONSTRAINT run_failure_notification_audit_fact_type_valid CHECK (((fact_type)::text = ANY (ARRAY[('intent_created'::character varying)::text, ('dispatch_marked'::character varying)::text, ('delivered'::character varying)::text, ('retry_scheduled'::character varying)::text, ('dead_lettered'::character varying)::text, ('outcome_unknown'::character varying)::text]))),
    CONSTRAINT run_failure_notification_audit_safe_error_code_format CHECK (((safe_error_code IS NULL) OR ((safe_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text)))
);


ALTER TABLE app.run_failure_notification_audit_facts OWNER TO pertexo_owner;

--
-- Name: run_failure_notification_intents; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.run_failure_notification_intents (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_run_id uuid NOT NULL,
    terminal_event_sequence integer CONSTRAINT run_failure_notification_inten_terminal_event_sequence_not_null NOT NULL,
    destination_id uuid NOT NULL,
    destination_config_version integer CONSTRAINT run_failure_notification_in_destination_config_version_not_null NOT NULL,
    side_effect_class character varying(32) NOT NULL,
    context jsonb NOT NULL,
    context_checksum character(64) NOT NULL,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    delivery_attempts integer DEFAULT 0 NOT NULL,
    dispatch_marked_at timestamp with time zone,
    recovery_at timestamp with time zone,
    next_delivery_at timestamp with time zone,
    safe_error_code character varying(128),
    possibly_dispatched boolean,
    provider_reference character varying(256),
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    connection_secret_version_id uuid,
    delivery_binding character varying(128),
    dispatched_config_version integer,
    dispatched_secret_version_id uuid,
    CONSTRAINT run_failure_notification_intents_attempts_bounded CHECK (((delivery_attempts >= 0) AND (delivery_attempts <= 10))),
    CONSTRAINT run_failure_notification_intents_checksum_format CHECK ((context_checksum ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT run_failure_notification_intents_context_bounded CHECK ((octet_length((context)::text) <= 4096)),
    CONSTRAINT run_failure_notification_intents_context_object CHECK ((jsonb_typeof(context) = 'object'::text)),
    CONSTRAINT run_failure_notification_intents_delivery_binding_format CHECK (((delivery_binding IS NULL) OR ((delivery_binding)::text ~ '^email:sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT run_failure_notification_intents_destination_version_positive CHECK ((destination_config_version > 0)),
    CONSTRAINT run_failure_notification_intents_lifecycle_valid CHECK (((((status)::text = 'pending'::text) AND (delivery_attempts = 0) AND (dispatch_marked_at IS NULL) AND (recovery_at IS NULL) AND (next_delivery_at IS NULL) AND (completed_at IS NULL)) OR (((status)::text = 'claimed'::text) AND (delivery_attempts > 0) AND (dispatch_marked_at IS NULL) AND (recovery_at IS NOT NULL) AND (next_delivery_at IS NULL) AND (completed_at IS NULL)) OR (((status)::text = 'dispatching'::text) AND (delivery_attempts > 0) AND (dispatch_marked_at IS NOT NULL) AND (recovery_at IS NOT NULL) AND (next_delivery_at IS NULL) AND (completed_at IS NULL)) OR (((status)::text = 'retry'::text) AND (delivery_attempts > 0) AND (dispatch_marked_at IS NULL) AND (recovery_at IS NULL) AND (next_delivery_at IS NOT NULL) AND (completed_at IS NULL)) OR (((status)::text = ANY (ARRAY[('delivered'::character varying)::text, ('dead_letter'::character varying)::text, ('outcome_unknown'::character varying)::text])) AND (dispatch_marked_at IS NULL) AND (recovery_at IS NULL) AND (next_delivery_at IS NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT run_failure_notification_intents_safe_error_code_format CHECK (((safe_error_code IS NULL) OR ((safe_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT run_failure_notification_intents_sequence_positive CHECK ((terminal_event_sequence > 0)),
    CONSTRAINT run_failure_notification_intents_side_effect_class_valid CHECK (((side_effect_class)::text = ANY (ARRAY[('safe'::character varying)::text, ('idempotent_with_key'::character varying)::text, ('unsafe'::character varying)::text]))),
    CONSTRAINT run_failure_notification_intents_status_valid CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('claimed'::character varying)::text, ('dispatching'::character varying)::text, ('retry'::character varying)::text, ('delivered'::character varying)::text, ('dead_letter'::character varying)::text, ('outcome_unknown'::character varying)::text])))
);


ALTER TABLE app.run_failure_notification_intents OWNER TO pertexo_owner;

--
-- Name: system_mail_deliveries; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.system_mail_deliveries (
    id uuid CONSTRAINT authentication_mail_deliveries_id_not_null NOT NULL,
    purpose character varying(32) CONSTRAINT authentication_mail_deliveries_purpose_not_null NOT NULL,
    status character varying(32) DEFAULT 'queued'::character varying CONSTRAINT authentication_mail_deliveries_status_not_null NOT NULL,
    expires_at timestamp with time zone CONSTRAINT authentication_mail_deliveries_expires_at_not_null NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT clock_timestamp() CONSTRAINT authentication_mail_deliveries_next_attempt_at_not_null NOT NULL,
    attempt_count integer DEFAULT 0 CONSTRAINT authentication_mail_deliveries_attempt_count_not_null NOT NULL,
    lease_owner character varying(128),
    lease_token uuid,
    lease_generation bigint DEFAULT 0 CONSTRAINT authentication_mail_deliveries_lease_generation_not_null NOT NULL,
    lease_expires_at timestamp with time zone,
    payload_ciphertext text,
    payload_nonce character varying(128),
    payload_tag character varying(256),
    payload_key_version character varying(64),
    provider_reference character varying(512),
    failure_code character varying(128),
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() CONSTRAINT authentication_mail_deliveries_created_at_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() CONSTRAINT authentication_mail_deliveries_updated_at_not_null NOT NULL,
    had_uncertain_attempt boolean DEFAULT false NOT NULL,
    CONSTRAINT system_mail_active_has_payload CHECK ((((status)::text <> ALL (ARRAY[('queued'::character varying)::text, ('outcome_unknown'::character varying)::text, ('retry'::character varying)::text])) OR (payload_ciphertext IS NOT NULL))),
    CONSTRAINT system_mail_attempts_bounded CHECK (((attempt_count >= 0) AND (attempt_count <= 12))),
    CONSTRAINT system_mail_expiry_after_creation CHECK ((expires_at > created_at)),
    CONSTRAINT system_mail_lease_complete CHECK ((((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT system_mail_payload_complete CHECK ((((payload_ciphertext IS NULL) AND (payload_nonce IS NULL) AND (payload_tag IS NULL) AND (payload_key_version IS NULL)) OR ((payload_ciphertext IS NOT NULL) AND (payload_nonce IS NOT NULL) AND (payload_tag IS NOT NULL) AND (payload_key_version IS NOT NULL)))),
    CONSTRAINT system_mail_purpose_valid CHECK (((purpose)::text = ANY (ARRAY[('workflow_failure_alert'::character varying)::text, ('verification'::character varying)::text, ('password_reset'::character varying)::text, ('email_change_confirmation'::character varying)::text, ('workspace_notice'::character varying)::text, ('two_factor_disabled'::character varying)::text, ('recovery_code_sign_in'::character varying)::text]))),
    CONSTRAINT system_mail_status_valid CHECK (((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('outcome_unknown'::character varying)::text, ('retry'::character varying)::text, ('submitted'::character varying)::text, ('failed'::character varying)::text, ('reconciliation_required'::character varying)::text, ('expired'::character varying)::text])))
);


ALTER TABLE app.system_mail_deliveries OWNER TO pertexo_owner;

--
-- Name: transport_security_audit_facts; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.transport_security_audit_facts (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    fact_type character varying(64) NOT NULL,
    consumer_name character varying(128) NOT NULL,
    message_id uuid NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT transport_security_audit_consumer_name_format CHECK (((consumer_name)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT transport_security_audit_fact_type CHECK (((fact_type)::text = 'inbox_checksum_mismatch'::text))
);


ALTER TABLE app.transport_security_audit_facts OWNER TO pertexo_owner;

--
-- Name: trigger_coordinated_events; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.trigger_coordinated_events (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    node_id character varying(128) NOT NULL,
    source character varying(16) NOT NULL,
    mode character varying(16) NOT NULL,
    initial_outcome character varying(16) NOT NULL,
    status character varying(16) NOT NULL,
    initial_status character varying(16) NOT NULL,
    reason character varying(32),
    run_id uuid,
    version_number integer NOT NULL,
    received_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '90 days'::interval) NOT NULL,
    finished_at timestamp with time zone,
    key_id uuid,
    workflow_version_id uuid,
    endpoint_id uuid,
    policy jsonb,
    input_ref json,
    input_bytes integer DEFAULT 0 NOT NULL,
    due_at timestamp with time zone,
    deadline_at timestamp with time zone,
    capacity_wait_started_at timestamp with time zone,
    started_by uuid,
    CONSTRAINT trigger_coordinated_events_kind CHECK ((((source)::text = ANY ((ARRAY['webhook'::character varying, 'form'::character varying])::text[])) AND ((mode)::text = ANY ((ARRAY['deduplicate'::character varying, 'debounce'::character varying, 'throttle'::character varying])::text[])) AND ((initial_outcome)::text = ANY ((ARRAY['accepted'::character varying, 'skipped'::character varying, 'deduplicated'::character varying, 'debounced'::character varying, 'throttled'::character varying, 'refused'::character varying])::text[])) AND ((initial_status)::text = ANY ((ARRAY['pending'::character varying, 'started'::character varying, 'skipped'::character varying, 'refused'::character varying])::text[])) AND ((status)::text = ANY ((ARRAY['pending'::character varying, 'started'::character varying, 'skipped'::character varying, 'coalesced'::character varying, 'refused'::character varying])::text[])) AND ((reason IS NULL) OR ((reason)::text = ANY ((ARRAY['duplicate_key'::character varying, 'newer_event'::character varying, 'throttle_limit'::character varying, 'invalid_key'::character varying, 'coordination_full'::character varying, 'coordination_timeout'::character varying, 'queue_full'::character varying, 'concurrency_limit'::character varying, 'workflow_unavailable'::character varying, 'publication_changed'::character varying, 'endpoint_disabled'::character varying, 'release_failed'::character varying])::text[]))) AND (version_number > 0))),
    CONSTRAINT trigger_coordinated_events_retention CHECK (((expires_at >= (received_at + '89 days 23:59:59'::interval)) AND (expires_at <= (received_at + '90 days 00:00:01'::interval)))),
    CONSTRAINT trigger_coordinated_events_state CHECK ((((((status)::text = 'pending'::text) AND (key_id IS NOT NULL) AND (workflow_version_id IS NOT NULL) AND (policy IS NOT NULL) AND (input_ref IS NOT NULL) AND ((input_ref ->> 'kind'::text) = 'inline'::text) AND (octet_length((input_ref)::text) <= 4194304) AND (octet_length((policy)::text) <= 65536) AND ((input_bytes >= 1) AND (input_bytes <= 262144)) AND (due_at IS NOT NULL) AND (deadline_at IS NOT NULL) AND (finished_at IS NULL) AND (run_id IS NULL) AND (((source)::text = 'webhook'::text) = (endpoint_id IS NOT NULL))) OR (((status)::text <> 'pending'::text) AND (key_id IS NULL) AND (workflow_version_id IS NULL) AND (endpoint_id IS NULL) AND (policy IS NULL) AND (input_ref IS NULL) AND (input_bytes = 0) AND (due_at IS NULL) AND (deadline_at IS NULL) AND (capacity_wait_started_at IS NULL) AND (started_by IS NULL) AND (finished_at IS NOT NULL))) AND (((status)::text = 'started'::text) = (run_id IS NOT NULL))))
);


ALTER TABLE app.trigger_coordinated_events OWNER TO pertexo_owner;

--
-- Name: trigger_event_windows; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.trigger_event_windows (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    node_id character varying(128) NOT NULL,
    policy_hash character(64) NOT NULL,
    key_hash character(64) NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    used_count integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT trigger_event_windows_bounds CHECK (((policy_hash ~ '^[0-9a-f]{64}$'::text) AND (key_hash ~ '^[0-9a-f]{64}$'::text) AND ((used_count >= 0) AND (used_count <= 1000)) AND (expires_at > window_started_at)))
);


ALTER TABLE app.trigger_event_windows OWNER TO pertexo_owner;

--
-- Name: trigger_schedule_occurrences; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.trigger_schedule_occurrences (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    trigger_id uuid NOT NULL,
    scheduled_at timestamp with time zone NOT NULL,
    disposition character varying(16) NOT NULL,
    workflow_run_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    skip_reason character varying(32),
    CONSTRAINT schedule_occurrence_skip_valid CHECK (((skip_reason IS NULL) OR (((skip_reason)::text = 'concurrency_limit'::text) AND ((disposition)::text = 'skipped'::text) AND (workflow_run_id IS NULL)))),
    CONSTRAINT trigger_schedule_occurrences_disposition_valid CHECK (((((disposition)::text = 'accepted'::text) AND (workflow_run_id IS NOT NULL)) OR (((disposition)::text = ANY (ARRAY[('skipped'::character varying)::text, ('paused'::character varying)::text])) AND (workflow_run_id IS NULL))))
);


ALTER TABLE app.trigger_schedule_occurrences OWNER TO pertexo_owner;

--
-- Name: trigger_schedules; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.trigger_schedules (
    trigger_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    recurrence_kind character varying(16) NOT NULL,
    cron_expression character varying(256),
    timezone character varying(128),
    interval_minutes integer,
    misfire_policy character varying(32) NOT NULL,
    config_fingerprint character varying(79) NOT NULL,
    anchor_at timestamp with time zone NOT NULL,
    next_fire_at timestamp with time zone NOT NULL,
    last_fire_at timestamp with time zone,
    status character varying(16) DEFAULT 'enabled'::character varying NOT NULL,
    health_status character varying(32) DEFAULT 'healthy'::character varying NOT NULL,
    last_error_code character varying(128),
    lease_owner character varying(128),
    lease_token uuid,
    lease_acquired_at timestamp with time zone,
    lease_expires_at timestamp with time zone,
    admission_deferred_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    retired_at timestamp with time zone,
    CONSTRAINT trigger_schedules_cursor_valid CHECK (((last_fire_at IS NULL) OR (last_fire_at < next_fire_at))),
    CONSTRAINT trigger_schedules_fingerprint_valid CHECK (((config_fingerprint)::text ~ '^trigger:sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT trigger_schedules_health_valid CHECK (((health_status)::text = ANY (ARRAY[('healthy'::character varying)::text, ('degraded'::character varying)::text, ('unhealthy'::character varying)::text, ('disabled'::character varying)::text]))),
    CONSTRAINT trigger_schedules_lease_valid CHECK (((((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_acquired_at IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_acquired_at IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (lease_expires_at > lease_acquired_at) AND (lease_expires_at <= (lease_acquired_at + '00:05:00'::interval)))) IS TRUE)),
    CONSTRAINT trigger_schedules_misfire_valid CHECK (((misfire_policy)::text = ANY (ARRAY[('catch_up_once'::character varying)::text, ('skip'::character varying)::text]))),
    CONSTRAINT trigger_schedules_recurrence_valid CHECK ((((((recurrence_kind)::text = 'cron'::text) AND (cron_expression IS NOT NULL) AND (timezone IS NOT NULL) AND (interval_minutes IS NULL)) OR (((recurrence_kind)::text = 'interval'::text) AND (cron_expression IS NULL) AND (timezone IS NULL) AND (interval_minutes IS NOT NULL) AND ((interval_minutes >= 1) AND (interval_minutes <= 43200)))) IS TRUE)),
    CONSTRAINT trigger_schedules_status_valid CHECK (((status)::text = ANY (ARRAY[('enabled'::character varying)::text, ('disabled'::character varying)::text])))
);


ALTER TABLE app.trigger_schedules OWNER TO pertexo_owner;

--
-- Name: usage_events; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.usage_events (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    category character varying(64) NOT NULL,
    quantity bigint NOT NULL,
    resource_type character varying(64) NOT NULL,
    resource_id uuid NOT NULL,
    idempotency_key character varying(128) NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT usage_events_category_format CHECK (((category)::text ~ '^[a-z][a-z0-9._:-]{0,63}$'::text)),
    CONSTRAINT usage_events_idempotency_key_format CHECK (((idempotency_key)::text ~ '^[A-Za-z0-9._:-]{1,128}$'::text)),
    CONSTRAINT usage_events_metadata_bounded CHECK ((octet_length((metadata)::text) <= 4096)),
    CONSTRAINT usage_events_preview_uuid_v7 CHECK ((((category)::text <> 'preview_execution'::text) OR (uuid_extract_version(id) = 7))),
    CONSTRAINT usage_events_quantity_positive CHECK ((quantity > 0)),
    CONSTRAINT usage_events_resource_type_format CHECK (((resource_type)::text ~ '^[a-z][a-z0-9._:-]{0,63}$'::text))
);


ALTER TABLE app.usage_events OWNER TO pertexo_owner;

--
-- Name: user_profile_command_receipts; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.user_profile_command_receipts (
    id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) NOT NULL,
    status character varying(32) NOT NULL,
    result_ref jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT user_profile_command_receipts_hashes_valid CHECK (((key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT user_profile_command_receipts_result_valid CHECK (((((status)::text = 'in_progress'::text) AND (result_ref IS NULL)) OR (((status)::text = 'completed'::text) AND (result_ref IS NOT NULL)))),
    CONSTRAINT user_profile_command_receipts_status_valid CHECK (((status)::text = ANY (ARRAY[('in_progress'::character varying)::text, ('completed'::character varying)::text])))
);


ALTER TABLE app.user_profile_command_receipts OWNER TO pertexo_owner;

--
-- Name: users; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.users (
    id uuid NOT NULL,
    email character varying(320) NOT NULL,
    display_name character varying(256) NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    status character varying(32) DEFAULT 'active'::character varying NOT NULL,
    profile_revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    two_factor_enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT users_email_format CHECK ((((email)::text = btrim((email)::text)) AND ((length((email)::text) >= 3) AND (length((email)::text) <= 320)))),
    CONSTRAINT users_profile_revision_positive CHECK ((profile_revision > 0)),
    CONSTRAINT users_status_valid CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text, ('deleted'::character varying)::text])))
);


ALTER TABLE app.users OWNER TO pertexo_owner;

--
-- Name: webhook_endpoint_ingress_limits; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.webhook_endpoint_ingress_limits (
    endpoint_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    bucket_started_at timestamp with time zone NOT NULL,
    request_count integer NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT webhook_endpoint_ingress_limits_count_valid CHECK ((request_count >= 1))
);


ALTER TABLE app.webhook_endpoint_ingress_limits OWNER TO pertexo_owner;

--
-- Name: webhook_run_responses; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.webhook_run_responses (
    run_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    wait_seconds integer NOT NULL,
    status_code integer,
    content_type character varying(64),
    headers jsonb,
    body text,
    node_run_id uuid,
    invocation_key character varying(256),
    responded_at timestamp with time zone,
    CONSTRAINT webhook_run_responses_body_bound CHECK ((octet_length(body) <= 1048576)),
    CONSTRAINT webhook_run_responses_complete CHECK (((((responded_at IS NULL) AND (status_code IS NULL) AND (content_type IS NULL) AND (headers IS NULL) AND (body IS NULL) AND (node_run_id IS NULL) AND (invocation_key IS NULL)) OR ((responded_at IS NOT NULL) AND ((status_code >= 200) AND (status_code <= 599)) AND ((content_type)::text = ANY ((ARRAY['application/json'::character varying, 'text/plain'::character varying, 'text/csv'::character varying, 'application/xml'::character varying])::text[])) AND (headers IS NOT NULL) AND (jsonb_typeof(headers) = 'object'::text) AND (body IS NOT NULL) AND (node_run_id IS NOT NULL) AND (invocation_key IS NOT NULL))) IS TRUE)),
    CONSTRAINT webhook_run_responses_wait_valid CHECK (((wait_seconds >= 1) AND (wait_seconds <= 30)))
);


ALTER TABLE app.webhook_run_responses OWNER TO pertexo_owner;

--
-- Name: webhook_test_events; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.webhook_test_events (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    node_id character varying(64) NOT NULL,
    created_by uuid NOT NULL,
    endpoint_key_hash character(64) NOT NULL,
    binding text NOT NULL,
    authentication jsonb NOT NULL,
    kms_key_reference character varying(2048) NOT NULL,
    encrypted_data_key text NOT NULL,
    ciphertext text NOT NULL,
    nonce character varying(64) NOT NULL,
    auth_tag character varying(64) NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    output_ref text,
    received_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT webhook_test_events_attempts_valid CHECK (((attempts >= 0) AND (attempts <= 60))),
    CONSTRAINT webhook_test_events_expiry_valid CHECK ((expires_at > created_at)),
    CONSTRAINT webhook_test_events_hash_valid CHECK ((endpoint_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT webhook_test_events_output_valid CHECK ((((output_ref IS NULL) AND (received_at IS NULL)) OR ((output_ref IS NOT NULL) AND (received_at IS NOT NULL) AND (octet_length(output_ref) <= 262200) AND (((output_ref)::jsonb ->> 'kind'::text) = 'inline'::text))))
);


ALTER TABLE app.webhook_test_events OWNER TO pertexo_owner;

--
-- Name: webhook_trigger_deliveries; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.webhook_trigger_deliveries (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    endpoint_id uuid NOT NULL,
    workflow_run_id uuid,
    received_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '90 days'::interval) NOT NULL,
    outcome character varying(32) DEFAULT 'accepted'::character varying NOT NULL,
    http_status smallint DEFAULT 202 NOT NULL,
    signature_check character varying(16) DEFAULT 'verified'::character varying NOT NULL,
    replay_check character varying(16) DEFAULT 'new'::character varying NOT NULL,
    body_bytes integer,
    skip_reason character varying(32),
    coordination_event_id uuid,
    CONSTRAINT webhook_trigger_deliveries_body_bytes_valid CHECK (((body_bytes IS NULL) OR ((body_bytes >= 0) AND (body_bytes <= 262144)))),
    CONSTRAINT webhook_trigger_deliveries_outcome_valid CHECK ((((((outcome)::text = 'coordinated'::text) AND (http_status = 202) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = ANY ((ARRAY['new'::character varying, 'duplicate'::character varying])::text[])) AND (workflow_run_id IS NULL) AND (skip_reason IS NULL) AND (coordination_event_id IS NOT NULL)) OR (((outcome)::text = 'skipped'::text) AND (http_status = 202) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = ANY ((ARRAY['new'::character varying, 'duplicate'::character varying])::text[])) AND (workflow_run_id IS NULL) AND ((skip_reason)::text = 'concurrency_limit'::text)) OR ((skip_reason IS NULL) AND ((((outcome)::text = 'accepted'::text) AND (http_status = 202) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text) AND (workflow_run_id IS NOT NULL)) OR (((outcome)::text = 'replayed'::text) AND (http_status = 202) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'duplicate'::text) AND (workflow_run_id IS NOT NULL)) OR ((workflow_run_id IS NULL) AND ((((outcome)::text = 'authentication_failed'::text) AND (http_status = 401) AND ((((signature_check)::text = 'not_checked'::text) AND ((replay_check)::text = 'stale_timestamp'::text)) OR (((signature_check)::text = 'mismatch'::text) AND ((replay_check)::text = 'not_checked'::text)) OR (((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text)))) OR (((outcome)::text = 'invalid_request'::text) AND (http_status = 400) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'not_checked'::text)) OR (((outcome)::text = 'conflict'::text) AND (http_status = 409) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'conflict'::text)) OR (((outcome)::text = 'rate_limited'::text) AND (http_status = 429) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text)) OR (((outcome)::text = 'paused'::text) AND (http_status = 423) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text))))))) IS TRUE)),
    CONSTRAINT webhook_trigger_deliveries_retention_valid CHECK (((expires_at >= (received_at + '89 days 23:59:59'::interval)) AND (expires_at <= (received_at + '90 days 00:00:01'::interval))))
);


ALTER TABLE app.webhook_trigger_deliveries OWNER TO pertexo_owner;

--
-- Name: webhook_trigger_endpoints; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.webhook_trigger_endpoints (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    endpoint_key_hash character(64) NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    current_secret_version_id uuid NOT NULL,
    previous_secret_version_id uuid,
    previous_secret_valid_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    authentication jsonb DEFAULT '{"mode": "signed", "allowedOrigins": []}'::jsonb NOT NULL,
    workflow_id uuid NOT NULL,
    node_id character varying(128) NOT NULL,
    CONSTRAINT webhook_trigger_endpoints_hash_valid CHECK ((endpoint_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT webhook_trigger_endpoints_rotation_valid CHECK ((((previous_secret_version_id IS NULL) AND (previous_secret_valid_until IS NULL)) OR ((previous_secret_version_id IS NOT NULL) AND (previous_secret_valid_until IS NOT NULL) AND (previous_secret_version_id <> current_secret_version_id)))),
    CONSTRAINT webhook_trigger_endpoints_status_valid CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('disabled'::character varying)::text])))
);


ALTER TABLE app.webhook_trigger_endpoints OWNER TO pertexo_owner;

--
-- Name: webhook_trigger_replay_records; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.webhook_trigger_replay_records (
    workspace_id uuid NOT NULL,
    endpoint_id uuid NOT NULL,
    dedupe_key_hash character(64) NOT NULL,
    request_fingerprint character(64) NOT NULL,
    delivery_id uuid NOT NULL,
    workflow_run_id uuid,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    skip_reason character varying(32),
    coordination_event_id uuid,
    CONSTRAINT webhook_replay_skip_valid CHECK (((skip_reason IS NULL) OR (((skip_reason)::text = 'concurrency_limit'::text) AND (workflow_run_id IS NULL)))),
    CONSTRAINT webhook_trigger_replay_records_expiry_valid CHECK ((expires_at > created_at)),
    CONSTRAINT webhook_trigger_replay_records_hashes_valid CHECK (((dedupe_key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_fingerprint ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT webhook_trigger_replay_retention_valid CHECK (((expires_at >= (created_at + '23:59:59'::interval)) AND (expires_at <= (created_at + '24:00:01'::interval))))
);


ALTER TABLE app.webhook_trigger_replay_records OWNER TO pertexo_owner;

--
-- Name: webhook_trigger_secret_versions; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.webhook_trigger_secret_versions (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    trigger_id uuid NOT NULL,
    purpose character varying(32) DEFAULT 'webhook_hmac_sha256'::character varying NOT NULL,
    kms_key_reference character varying(2048) NOT NULL,
    encrypted_data_key text NOT NULL,
    ciphertext text NOT NULL,
    nonce character varying(64) NOT NULL,
    auth_tag character varying(64) NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    workflow_id uuid NOT NULL,
    node_id character varying(128) NOT NULL,
    CONSTRAINT webhook_trigger_secret_versions_purpose_valid CHECK (((purpose)::text = 'webhook_hmac_sha256'::text))
);


ALTER TABLE app.webhook_trigger_secret_versions OWNER TO pertexo_owner;

--
-- Name: workflow_calls; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_calls (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    parent_run_id uuid NOT NULL,
    invocation_key character varying(256) NOT NULL,
    target_workflow_id uuid NOT NULL,
    target_version_id uuid NOT NULL,
    target_checksum character varying(77) NOT NULL,
    input_ref json,
    input_checksum character(64) NOT NULL,
    deadline_at timestamp with time zone,
    status character varying(32) NOT NULL,
    child_run_id uuid,
    live_child_run_id uuid,
    result_ref json,
    safe_error_code character varying(128),
    slot_lent boolean DEFAULT false NOT NULL,
    consumed_at timestamp with time zone,
    details_purged_at timestamp with time zone,
    cancel_requested_at timestamp with time zone,
    cancel_applied_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT workflow_calls_live_child_identity_valid CHECK (((live_child_run_id IS NULL) OR ((child_run_id IS NOT NULL) AND (live_child_run_id = child_run_id)))),
    CONSTRAINT workflow_calls_retired_details_valid CHECK (((details_purged_at IS NULL) OR ((input_ref IS NULL) AND (result_ref IS NULL)))),
    CONSTRAINT workflow_calls_status_valid CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'refused'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'canceled'::character varying, 'timed_out'::character varying, 'outcome_unknown'::character varying])::text[]))),
    CONSTRAINT workflow_calls_values_bounded CHECK ((((input_ref IS NULL) OR (octet_length((input_ref)::text) <= 4194304)) AND ((result_ref IS NULL) OR (octet_length((result_ref)::text) <= 4194304))))
);


ALTER TABLE app.workflow_calls OWNER TO pertexo_owner;

--
-- Name: workflow_comment_mentions; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_comment_mentions (
    workspace_id uuid NOT NULL,
    id uuid NOT NULL,
    comment_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


ALTER TABLE app.workflow_comment_mentions OWNER TO pertexo_owner;

--
-- Name: workflow_comment_threads; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_comment_threads (
    workspace_id uuid NOT NULL,
    id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    step_id character varying(128),
    step_label character varying(256),
    status character varying(16) DEFAULT 'open'::character varying NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_by uuid,
    comment_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT comment_thread_shape CHECK (((revision > 0) AND (comment_count >= 0) AND ((status)::text = ANY ((ARRAY['open'::character varying, 'resolved'::character varying])::text[])) AND (((step_id IS NULL) AND (step_label IS NULL)) OR ((length((step_id)::text) > 0) AND (step_label IS NOT NULL)))))
);


ALTER TABLE app.workflow_comment_threads OWNER TO pertexo_owner;

--
-- Name: workflow_comments; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_comments (
    workspace_id uuid NOT NULL,
    id uuid NOT NULL,
    thread_id uuid NOT NULL,
    author_id uuid,
    body text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    edited_at timestamp with time zone,
    CONSTRAINT comment_text_valid CHECK ((((length(btrim(body)) >= 1) AND (length(btrim(body)) <= 8000)) AND (revision > 0)))
);


ALTER TABLE app.workflow_comments OWNER TO pertexo_owner;

--
-- Name: workflow_concurrency_policies; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_concurrency_policies (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    active_run_limit integer,
    revision integer DEFAULT 1 NOT NULL,
    overflow character varying(8) DEFAULT 'queue'::character varying NOT NULL,
    CONSTRAINT workflow_concurrency_policies_active_run_limit_check CHECK (((active_run_limit >= 1) AND (active_run_limit <= 10000))),
    CONSTRAINT workflow_concurrency_policies_overflow_check CHECK (((overflow)::text = ANY ((ARRAY['queue'::character varying, 'skip'::character varying])::text[]))),
    CONSTRAINT workflow_concurrency_policies_revision_check CHECK ((revision > 0))
);


ALTER TABLE app.workflow_concurrency_policies OWNER TO pertexo_owner;

--
-- Name: workflow_drafts; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_drafts (
    workflow_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    graph_json json NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_drafts_graph_bounded CHECK ((octet_length((graph_json)::text) <= 2097152)),
    CONSTRAINT workflow_drafts_graph_object CHECK ((json_typeof(graph_json) = 'object'::text)),
    CONSTRAINT workflow_drafts_revision_positive CHECK ((revision > 0))
);


ALTER TABLE app.workflow_drafts OWNER TO pertexo_owner;

--
-- Name: workflow_error_policies; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_error_policies (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    target_workflow_id uuid,
    revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT workflow_error_policies_different_target CHECK ((workflow_id <> target_workflow_id)),
    CONSTRAINT workflow_error_policies_revision_positive CHECK ((revision > 0))
);


ALTER TABLE app.workflow_error_policies OWNER TO pertexo_owner;

--
-- Name: workflow_failure_notification_policies; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_failure_notification_policies (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    destination_id uuid NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


ALTER TABLE app.workflow_failure_notification_policies OWNER TO pertexo_owner;

--
-- Name: workflow_failure_streaks; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_failure_streaks (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    consecutive_failures integer NOT NULL,
    resumed_after timestamp with time zone,
    last_run_id uuid,
    last_ended_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    legacy_failures integer DEFAULT 0 NOT NULL,
    success_ended_at timestamp with time zone,
    success_outcome_id uuid,
    CONSTRAINT workflow_failure_streaks_consecutive_failures_check CHECK ((consecutive_failures >= 0)),
    CONSTRAINT workflow_failure_streaks_last_run_valid CHECK (((last_run_id IS NULL) = (last_ended_at IS NULL))),
    CONSTRAINT workflow_failure_streaks_legacy_failures_check CHECK (((legacy_failures >= 0) AND (legacy_failures <= consecutive_failures))),
    CONSTRAINT workflow_failure_streaks_success_valid CHECK (((success_ended_at IS NULL) = (success_outcome_id IS NULL)))
);


ALTER TABLE app.workflow_failure_streaks OWNER TO pertexo_owner;

--
-- Name: workflow_favorites; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_favorites (
    workspace_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    workflow_id uuid NOT NULL
);


ALTER TABLE app.workflow_favorites OWNER TO pertexo_owner;

--
-- Name: workflow_folder_grants; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_folder_grants (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    folder_id uuid NOT NULL,
    user_id uuid,
    organization_id uuid,
    group_id uuid,
    access character varying(16) NOT NULL,
    CONSTRAINT workflow_folder_grants_access_valid CHECK (((access)::text = ANY ((ARRAY['viewer'::character varying, 'editor'::character varying])::text[]))),
    CONSTRAINT workflow_folder_grants_principal_valid CHECK ((((user_id IS NOT NULL) AND (organization_id IS NULL) AND (group_id IS NULL)) OR ((user_id IS NULL) AND (organization_id IS NOT NULL) AND (group_id IS NOT NULL))))
);


ALTER TABLE app.workflow_folder_grants OWNER TO pertexo_owner;

--
-- Name: workflow_folders; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_folders (
    workspace_id uuid NOT NULL,
    id uuid NOT NULL,
    parent_id uuid,
    name text NOT NULL COLLATE pg_catalog."C",
    name_key text NOT NULL COLLATE pg_catalog."C",
    revision bigint DEFAULT 1 NOT NULL,
    access_mode character varying(16) DEFAULT 'workspace'::character varying NOT NULL,
    CONSTRAINT workflow_folders_access_mode_valid CHECK (((access_mode)::text = ANY ((ARRAY['workspace'::character varying, 'restricted'::character varying])::text[]))),
    CONSTRAINT workflow_folders_check CHECK ((name_key = translate(name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'::text, 'abcdefghijklmnopqrstuvwxyz'::text))),
    CONSTRAINT workflow_folders_check1 CHECK ((parent_id IS DISTINCT FROM id)),
    CONSTRAINT workflow_folders_name_check CHECK (((name = btrim(name, ' '::text)) AND ((octet_length(name) >= 1) AND (octet_length(name) <= 128)) AND ((name COLLATE "C") !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workflow_folders_revision_check CHECK (((revision >= 1) AND (revision <= '9007199254740991'::bigint)))
);


ALTER TABLE app.workflow_folders OWNER TO pertexo_owner;

--
-- Name: workflow_forms; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_forms (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    public_id uuid NOT NULL,
    node_id character varying(128) NOT NULL,
    access character varying(16) DEFAULT 'members'::character varying NOT NULL,
    capability_hash character(64),
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sealed_capability jsonb,
    CONSTRAINT workflow_forms_access_valid CHECK ((((((access)::text = 'members'::text) AND (capability_hash IS NULL)) OR (((access)::text = 'public'::text) AND (capability_hash ~ '^[0-9a-f]{64}$'::text))) IS TRUE)),
    CONSTRAINT workflow_forms_revision_positive CHECK ((revision > 0)),
    CONSTRAINT workflow_forms_sealed_capability_valid CHECK (((sealed_capability IS NULL) OR (capability_hash IS NOT NULL)))
);


ALTER TABLE app.workflow_forms OWNER TO pertexo_owner;

--
-- Name: workflow_input_case_payloads; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_input_case_payloads (
    workspace_id uuid NOT NULL,
    case_id uuid NOT NULL,
    revision integer NOT NULL,
    input text NOT NULL,
    canonical_bytes integer NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expectations text,
    CONSTRAINT workflow_input_case_payloads_canonical_bytes_check CHECK (((canonical_bytes >= 1) AND (canonical_bytes <= 81920))),
    CONSTRAINT workflow_input_case_payloads_check CHECK (((octet_length(input) + COALESCE(octet_length(expectations), 0)) = canonical_bytes)),
    CONSTRAINT workflow_input_case_payloads_expectations_bound CHECK (((octet_length(input) <= 65536) AND ((expectations IS NULL) OR ((octet_length(expectations) <= 16384) AND (jsonb_typeof((expectations)::jsonb) = 'object'::text))))),
    CONSTRAINT workflow_input_case_payloads_input_check CHECK (((input)::jsonb IS NOT NULL)),
    CONSTRAINT workflow_input_case_payloads_revision_check CHECK ((revision > 0))
);


ALTER TABLE app.workflow_input_case_payloads OWNER TO pertexo_owner;

--
-- Name: workflow_input_cases; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_input_cases (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    workflow_version_id uuid NOT NULL,
    version_checksum character varying(77) NOT NULL,
    name character varying(128) NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT date_trunc('milliseconds'::text, clock_timestamp()) NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT workflow_input_cases_name_check CHECK (((length(btrim((name)::text)) >= 1) AND (length(btrim((name)::text)) <= 128))),
    CONSTRAINT workflow_input_cases_revision_check CHECK ((revision > 0))
);


ALTER TABLE app.workflow_input_cases OWNER TO pertexo_owner;

--
-- Name: workflow_integration_usage; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_integration_usage (
    workspace_id uuid NOT NULL,
    workflow_version_id uuid NOT NULL,
    provider_key character varying(64) NOT NULL,
    operation_key character varying(128) NOT NULL,
    connection_id uuid NOT NULL,
    CONSTRAINT workflow_integration_usage_operation_key_format CHECK (((operation_key)::text ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'::text)),
    CONSTRAINT workflow_integration_usage_provider_key_format CHECK (((provider_key)::text ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'::text))
);


ALTER TABLE app.workflow_integration_usage OWNER TO pertexo_owner;

--
-- Name: workflow_manual_start_rejections; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_manual_start_rejections (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    scope character varying(128) NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) NOT NULL,
    expected_version_id uuid NOT NULL,
    observed_version_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '24:00:00'::interval) NOT NULL,
    CONSTRAINT workflow_manual_start_rejections_check CHECK ((((scope)::text = (('workflow:'::text || (workflow_id)::text) || ':manual'::text)) OR ((scope)::text ~ '^api_token:[0-9a-f]{64}$'::text))),
    CONSTRAINT workflow_manual_start_rejections_check1 CHECK ((expected_version_id <> observed_version_id)),
    CONSTRAINT workflow_manual_start_rejections_key_hash_check CHECK ((key_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT workflow_manual_start_rejections_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text))
);


ALTER TABLE app.workflow_manual_start_rejections OWNER TO pertexo_owner;

--
-- Name: workflow_organization_state; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_organization_state (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    folder_id uuid,
    CONSTRAINT workflow_organization_state_revision_check CHECK (((revision >= 1) AND (revision <= '9007199254740991'::bigint)))
);


ALTER TABLE app.workflow_organization_state OWNER TO pertexo_owner;

--
-- Name: workflow_presence_leases; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_presence_leases (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    user_id uuid NOT NULL,
    tab_id uuid NOT NULL,
    sequence bigint NOT NULL,
    editing boolean NOT NULL,
    dirty boolean NOT NULL,
    base_revision integer,
    last_seen_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT presence_shape_valid CHECK (((sequence > 0) AND (sequence <= '9007199254740991'::bigint) AND (expires_at > last_seen_at) AND ((base_revision IS NULL) OR (base_revision > 0)) AND ((NOT dirty) OR editing) AND ((NOT editing) OR (base_revision IS NOT NULL))))
);


ALTER TABLE app.workflow_presence_leases OWNER TO pertexo_owner;

--
-- Name: workflow_promotion_origins; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_promotion_origins (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    source_workspace_id uuid NOT NULL,
    source_workflow_id uuid NOT NULL,
    source_version_id uuid NOT NULL,
    source_checksum character varying(82) NOT NULL,
    graph_digest character varying(64) NOT NULL,
    target_name character varying(128) NOT NULL,
    draft_revision integer NOT NULL,
    published_version_id uuid,
    promotion_id uuid NOT NULL,
    applied_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT promotion_origin_digests_valid CHECK ((((source_checksum)::text ~ '^wf:sha256:(v2:)?[a-f0-9]{64}$'::text) AND ((graph_digest)::text ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT promotion_origin_name_valid CHECK (((length(btrim((target_name)::text)) >= 1) AND (length(btrim((target_name)::text)) <= 128))),
    CONSTRAINT promotion_origin_revision_positive CHECK ((draft_revision > 0))
);


ALTER TABLE app.workflow_promotion_origins OWNER TO pertexo_owner;

--
-- Name: workflow_publication_requests; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_publication_requests (
    workspace_id uuid NOT NULL,
    id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    requested_by uuid NOT NULL,
    draft_revision integer NOT NULL,
    representation_tag character varying(64) NOT NULL,
    note character varying(1000) NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    comment character varying(1000),
    published_version_id uuid,
    reused boolean,
    CONSTRAINT publication_requests_decision_valid CHECK ((((((status)::text = ANY ((ARRAY['pending'::character varying, 'stale'::character varying])::text[])) AND (decided_by IS NULL) AND (decided_at IS NULL) AND (comment IS NULL) AND (published_version_id IS NULL) AND (reused IS NULL)) OR (((status)::text = 'rejected'::text) AND (decided_by IS NOT NULL) AND (decided_by <> requested_by) AND (decided_at IS NOT NULL) AND (published_version_id IS NULL) AND (reused IS NULL)) OR (((status)::text = 'approved'::text) AND (decided_by IS NOT NULL) AND (decided_by <> requested_by) AND (decided_at IS NOT NULL) AND (published_version_id IS NOT NULL) AND (reused IS NOT NULL))) IS TRUE)),
    CONSTRAINT publication_requests_expiry_valid CHECK ((expires_at > created_at)),
    CONSTRAINT publication_requests_note_valid CHECK (((length(btrim((note)::text)) >= 1) AND (length(btrim((note)::text)) <= 1000))),
    CONSTRAINT publication_requests_revision_valid CHECK (((draft_revision > 0) AND ((representation_tag)::text ~ '^"draft[.][A-Za-z0-9_-]{43}"$'::text))),
    CONSTRAINT publication_requests_status_valid CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying, 'stale'::character varying])::text[])))
);


ALTER TABLE app.workflow_publication_requests OWNER TO pertexo_owner;

--
-- Name: workflow_run_active_admissions; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_run_active_admissions (
    workspace_id uuid NOT NULL,
    workflow_run_id uuid NOT NULL,
    outbox_event_id uuid NOT NULL,
    recover_after timestamp with time zone,
    recovery_count bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    workflow_concurrency_order_exempt boolean DEFAULT true CONSTRAINT workflow_run_active_admissi_workflow_concurrency_order_not_null NOT NULL,
    borrowed_call_id uuid,
    CONSTRAINT workflow_run_active_admissions_recovery_count_valid CHECK ((recovery_count >= 0))
);


ALTER TABLE app.workflow_run_active_admissions OWNER TO pertexo_owner;

--
-- Name: workflow_run_admission_ticket_seq; Type: SEQUENCE; Schema: app; Owner: pertexo_owner
--

CREATE SEQUENCE app.workflow_run_admission_ticket_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE app.workflow_run_admission_ticket_seq OWNER TO pertexo_owner;

--
-- Name: workflow_run_values; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_run_values (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_run_id uuid,
    preview_run_id uuid,
    key character varying(50) NOT NULL,
    value character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_run_values_one_owner CHECK (((workflow_run_id IS NULL) <> (preview_run_id IS NULL)))
);


ALTER TABLE app.workflow_run_values OWNER TO pertexo_owner;

--
-- Name: workflow_runs; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_runs (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    workflow_version_id uuid NOT NULL,
    replay_source_run_id uuid,
    replay_command_id uuid,
    trigger_type character varying(32) NOT NULL,
    failure_notification_destination_id uuid,
    failure_notification_destination_config_version integer,
    failure_notification_side_effect_class character varying(32),
    failure_notification_connection_secret_version_id uuid,
    execution_entitlement_version integer,
    admission_ticket bigint NOT NULL,
    status character varying(32) NOT NULL,
    deadline_at timestamp with time zone,
    deadline_wakeup_at timestamp with time zone,
    cancel_requested_at timestamp with time zone,
    cancel_requested_by character varying(128),
    cancel_reason character varying(512),
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    input_ref json,
    input_ref_expires_at timestamp with time zone,
    details_purged_at timestamp with time zone,
    output_ref json,
    error_summary character varying(2048),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    recovery_target_node_run_id uuid,
    recovery_target_node_id character varying(128),
    recovery_reused_count integer,
    recovery_effect_risk character varying(32),
    recovery_effects_acknowledged boolean,
    handled_failure_count integer DEFAULT 0 NOT NULL,
    error_workflow_origin boolean DEFAULT false NOT NULL,
    started_by uuid,
    absolute_deadline_at timestamp with time zone,
    human_wait_started_at timestamp with time zone,
    remaining_execution_ms integer,
    variable_set_revision integer,
    timed_wait_started_at timestamp with time zone,
    CONSTRAINT workflow_runs_admission_ticket_positive CHECK ((admission_ticket > 0)),
    CONSTRAINT workflow_runs_cancel_actor_format CHECK (((cancel_requested_by IS NULL) OR ((cancel_requested_by)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'::text))),
    CONSTRAINT workflow_runs_cancel_metadata_complete CHECK ((((cancel_requested_at IS NULL) AND (cancel_requested_by IS NULL) AND (cancel_reason IS NULL)) OR ((cancel_requested_at IS NOT NULL) AND (cancel_requested_by IS NOT NULL)))),
    CONSTRAINT workflow_runs_deadline_valid CHECK (((deadline_at IS NULL) OR (deadline_at > created_at))),
    CONSTRAINT workflow_runs_deadline_wakeup_consistent CHECK ((((deadline_wakeup_at IS NULL) OR ((deadline_at IS NOT NULL) AND (deadline_wakeup_at = deadline_at))) IS TRUE)),
    CONSTRAINT workflow_runs_failure_notification_policy_complete CHECK (((((failure_notification_destination_id IS NULL) AND (failure_notification_destination_config_version IS NULL) AND (failure_notification_side_effect_class IS NULL) AND (failure_notification_connection_secret_version_id IS NULL)) OR ((failure_notification_destination_id IS NOT NULL) AND (failure_notification_destination_config_version IS NOT NULL) AND (failure_notification_destination_config_version > 0) AND (failure_notification_side_effect_class IS NOT NULL) AND ((failure_notification_side_effect_class)::text = ANY (ARRAY[('safe'::character varying)::text, ('idempotent_with_key'::character varying)::text, ('unsafe'::character varying)::text])))) IS TRUE)),
    CONSTRAINT workflow_runs_handled_failure_count_valid CHECK (((handled_failure_count >= 0) AND (handled_failure_count <= 200))),
    CONSTRAINT workflow_runs_human_wait_valid CHECK (((((human_wait_started_at IS NULL) AND (remaining_execution_ms IS NULL)) OR ((human_wait_started_at IS NOT NULL) AND ((remaining_execution_ms IS NULL) OR ((remaining_execution_ms > 0) AND (remaining_execution_ms <= 3600000))) AND ((status)::text = ANY ((ARRAY['waiting'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'canceled'::character varying, 'timed_out'::character varying, 'outcome_unknown'::character varying])::text[])) AND (NOT (deadline_at IS DISTINCT FROM absolute_deadline_at)))) IS TRUE)),
    CONSTRAINT workflow_runs_input_ref_expiry_valid CHECK ((((input_ref IS NULL) AND (input_ref_expires_at IS NULL)) OR ((input_ref IS NOT NULL) AND (input_ref_expires_at IS NOT NULL) AND (input_ref_expires_at > created_at) AND (input_ref_expires_at <= (created_at + '30 days'::interval))))),
    CONSTRAINT workflow_runs_recovery_summary_complete CHECK (((((recovery_target_node_run_id IS NULL) AND (recovery_target_node_id IS NULL) AND (recovery_reused_count IS NULL) AND (recovery_effect_risk IS NULL) AND (recovery_effects_acknowledged IS NULL)) OR (((trigger_type)::text = 'replay'::text) AND (recovery_target_node_run_id IS NOT NULL) AND (recovery_target_node_id IS NOT NULL) AND (recovery_reused_count IS NOT NULL) AND (recovery_reused_count >= 0) AND (recovery_reused_count <= 200) AND ((recovery_effect_risk)::text = ANY ((ARRAY['ordinary'::character varying, 'possible_effects'::character varying, 'unknown_outcome'::character varying])::text[])) AND (recovery_effects_acknowledged IS NOT NULL))) IS TRUE)),
    CONSTRAINT workflow_runs_replay_lineage_valid CHECK ((((trigger_type)::text = 'replay'::text) = ((replay_source_run_id IS NOT NULL) AND (replay_command_id IS NOT NULL)))),
    CONSTRAINT workflow_runs_status_valid CHECK (((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('waiting'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text]))),
    CONSTRAINT workflow_runs_trigger_type_valid CHECK (((trigger_type)::text = ANY (ARRAY[('test'::character varying)::text, ('form'::character varying)::text, ('workflow_error'::character varying)::text, ('api'::character varying)::text, ('manual'::character varying)::text, ('replay'::character varying)::text, ('schedule'::character varying)::text, ('webhook'::character varying)::text, ('workflow_call'::character varying)::text]))),
    CONSTRAINT workflow_runs_variable_set_retention CHECK (((details_purged_at IS NULL) OR (variable_set_revision IS NULL)))
)
WITH (autovacuum_vacuum_scale_factor='0.02', autovacuum_analyze_scale_factor='0.01', autovacuum_vacuum_insert_scale_factor='0.02');


ALTER TABLE app.workflow_runs OWNER TO pertexo_owner;

--
-- Name: workflow_step_samples; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_step_samples (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    node_id character varying(64) NOT NULL,
    binding text NOT NULL,
    output_ref text NOT NULL,
    retained_bytes integer NOT NULL,
    source_kind character varying(16) NOT NULL,
    source_run_id uuid,
    source_node_run_id uuid,
    source_preview_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT workflow_step_samples_bytes_valid CHECK (((retained_bytes = (octet_length(binding) + octet_length(output_ref))) AND (retained_bytes > 0) AND (retained_bytes <= 1310800))),
    CONSTRAINT workflow_step_samples_expiry_valid CHECK ((expires_at > created_at)),
    CONSTRAINT workflow_step_samples_output_valid CHECK (((octet_length(output_ref) <= 262200) AND (jsonb_typeof((output_ref)::jsonb) = 'object'::text) AND (((output_ref)::jsonb ->> 'kind'::text) = 'inline'::text) AND ((output_ref)::jsonb ? 'value'::text))),
    CONSTRAINT workflow_step_samples_source_valid CHECK ((((((source_kind)::text = ANY ((ARRAY['json'::character varying, 'webhook_test'::character varying])::text[])) AND (source_run_id IS NULL) AND (source_node_run_id IS NULL) AND (source_preview_id IS NULL)) OR (((source_kind)::text = 'run'::text) AND (source_run_id IS NOT NULL) AND (source_node_run_id IS NOT NULL) AND (source_preview_id IS NULL)) OR (((source_kind)::text = 'preview'::text) AND (source_run_id IS NULL) AND (source_node_run_id IS NULL) AND (source_preview_id IS NOT NULL))) IS TRUE))
);


ALTER TABLE app.workflow_step_samples OWNER TO pertexo_owner;

--
-- Name: workflow_tag_assignments; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_tag_assignments (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    tag_id uuid NOT NULL
);


ALTER TABLE app.workflow_tag_assignments OWNER TO pertexo_owner;

--
-- Name: workflow_tags; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_tags (
    workspace_id uuid NOT NULL,
    id uuid NOT NULL,
    key text NOT NULL COLLATE pg_catalog."C",
    revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT workflow_tags_key_check CHECK (((octet_length(key) >= 1) AND (octet_length(key) <= 32) AND ((key COLLATE "C") ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text))),
    CONSTRAINT workflow_tags_revision_check CHECK (((revision >= 1) AND (revision <= '9007199254740991'::bigint)))
);


ALTER TABLE app.workflow_tags OWNER TO pertexo_owner;

--
-- Name: workflow_template_origins; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_template_origins (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    origin jsonb NOT NULL,
    CONSTRAINT workflow_template_origins_origin_check CHECK (((jsonb_typeof(origin) = 'object'::text) AND (octet_length((origin)::text) <= 512)))
);


ALTER TABLE app.workflow_template_origins OWNER TO pertexo_owner;

--
-- Name: workflow_test_snapshots; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_test_snapshots (
    id uuid CONSTRAINT workflow_test_snapshots_run_id_not_null NOT NULL,
    workspace_id uuid NOT NULL,
    draft_revision integer NOT NULL,
    graph_json json NOT NULL,
    checksum character varying(77) NOT NULL,
    executable_json json NOT NULL,
    dispositions jsonb NOT NULL,
    pins json NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    workflow_id uuid NOT NULL,
    CONSTRAINT workflow_test_snapshots_checksum_valid CHECK (((checksum)::text ~ '^wf:sha256:(v2:)?[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_test_snapshots_executable_bound CHECK (((json_typeof(executable_json) = 'object'::text) AND (octet_length((executable_json)::text) <= 2097152))),
    CONSTRAINT workflow_test_snapshots_graph_bound CHECK (((json_typeof(graph_json) = 'object'::text) AND (octet_length((graph_json)::text) <= 2097152))),
    CONSTRAINT workflow_test_snapshots_pins_bound CHECK (((json_typeof(pins) = 'object'::text) AND (octet_length((pins)::text) <= 67108864))),
    CONSTRAINT workflow_test_snapshots_revision_positive CHECK ((draft_revision > 0))
);


ALTER TABLE app.workflow_test_snapshots OWNER TO pertexo_owner;

--
-- Name: workflow_test_suite_cases; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_test_suite_cases (
    workspace_id uuid NOT NULL,
    suite_id uuid NOT NULL,
    ordinal integer NOT NULL,
    case_id uuid NOT NULL,
    case_revision integer NOT NULL,
    name character varying(128) NOT NULL,
    input text NOT NULL,
    expectations text NOT NULL,
    run_id uuid,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    report text,
    CONSTRAINT workflow_test_suite_cases_ordinal_valid CHECK ((((ordinal >= 0) AND (ordinal <= 49)) AND (case_revision > 0))),
    CONSTRAINT workflow_test_suite_cases_payload_bound CHECK (((octet_length(input) <= 65536) AND ((input)::jsonb IS NOT NULL) AND (octet_length(expectations) <= 16384) AND (jsonb_typeof((expectations)::jsonb) = 'object'::text))),
    CONSTRAINT workflow_test_suite_cases_report_bound CHECK (((report IS NULL) OR ((octet_length(report) <= 262144) AND (jsonb_typeof((report)::jsonb) = 'object'::text)))),
    CONSTRAINT workflow_test_suite_cases_status_valid CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'passed'::character varying, 'failed'::character varying, 'error'::character varying, 'skipped'::character varying])::text[])))
);


ALTER TABLE app.workflow_test_suite_cases OWNER TO pertexo_owner;

--
-- Name: workflow_test_suites; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_test_suites (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    started_by uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    signature character varying(64) NOT NULL,
    variable_set_revision integer,
    uses_connections boolean NOT NULL,
    case_duration_ms integer NOT NULL,
    initial_checkpoint jsonb NOT NULL,
    status character varying(16) DEFAULT 'running'::character varying NOT NULL,
    stop_reason character varying(64),
    cancel_requested boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    deadline_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    next_check_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT workflow_test_suites_checkpoint_bound CHECK (((jsonb_typeof(initial_checkpoint) = 'object'::text) AND (octet_length((initial_checkpoint)::text) <= 262144))),
    CONSTRAINT workflow_test_suites_duration_valid CHECK ((((case_duration_ms >= 1) AND (case_duration_ms <= 300000)) AND (deadline_at > created_at) AND (expires_at > deadline_at))),
    CONSTRAINT workflow_test_suites_signature_valid CHECK (((signature)::text ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_test_suites_status_valid CHECK (((status)::text = ANY ((ARRAY['running'::character varying, 'passed'::character varying, 'failed'::character varying, 'canceled'::character varying, 'error'::character varying])::text[])))
);


ALTER TABLE app.workflow_test_suites OWNER TO pertexo_owner;

--
-- Name: workflow_trigger_failures; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_trigger_failures (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    run_id uuid NOT NULL,
    ended_at timestamp with time zone NOT NULL
);


ALTER TABLE app.workflow_trigger_failures OWNER TO pertexo_owner;

--
-- Name: workflow_trigger_outcomes; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_trigger_outcomes (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    run_id uuid NOT NULL,
    counts_as_failure boolean NOT NULL,
    ended_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


ALTER TABLE app.workflow_trigger_outcomes OWNER TO pertexo_owner;

--
-- Name: workflow_trigger_pause_periods; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_trigger_pause_periods (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    pause_revision bigint NOT NULL,
    paused_at timestamp with time zone NOT NULL,
    resumed_at timestamp with time zone NOT NULL,
    CONSTRAINT workflow_trigger_pause_periods_check CHECK ((resumed_at >= paused_at)),
    CONSTRAINT workflow_trigger_pause_periods_pause_revision_check CHECK ((pause_revision > 0))
);


ALTER TABLE app.workflow_trigger_pause_periods OWNER TO pertexo_owner;

--
-- Name: workflow_triggers; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_triggers (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    workflow_version_id uuid NOT NULL,
    node_id character varying(128) NOT NULL,
    kind character varying(16) NOT NULL,
    status character varying(32) DEFAULT 'desired'::character varying NOT NULL,
    desired_config jsonb NOT NULL,
    config_fingerprint character varying(79) NOT NULL,
    health_status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    last_error_code character varying(128),
    reconciled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workflow_triggers_config_bounded CHECK ((octet_length((desired_config)::text) <= 4096)),
    CONSTRAINT workflow_triggers_config_strict CHECK ((jsonb_typeof(desired_config) = 'object'::text)),
    CONSTRAINT workflow_triggers_fingerprint_valid CHECK (((config_fingerprint)::text ~ '^trigger:sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_triggers_health_valid CHECK (((health_status)::text = ANY (ARRAY[('pending'::character varying)::text, ('healthy'::character varying)::text, ('degraded'::character varying)::text, ('unhealthy'::character varying)::text, ('disabled'::character varying)::text]))),
    CONSTRAINT workflow_triggers_kind_valid CHECK (((kind)::text = ANY (ARRAY[('webhook'::character varying)::text, ('schedule'::character varying)::text]))),
    CONSTRAINT workflow_triggers_status_valid CHECK (((status)::text = ANY (ARRAY[('desired'::character varying)::text, ('configuration_required'::character varying)::text, ('pending'::character varying)::text, ('active'::character varying)::text, ('degraded'::character varying)::text, ('disabled'::character varying)::text, ('error'::character varying)::text])))
);


ALTER TABLE app.workflow_triggers OWNER TO pertexo_owner;

--
-- Name: workflow_version_dependencies; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_version_dependencies (
    workspace_id uuid NOT NULL,
    parent_version_id uuid NOT NULL,
    node_id character varying(64) NOT NULL,
    target_workflow_id uuid NOT NULL,
    target_version_id uuid NOT NULL
);


ALTER TABLE app.workflow_version_dependencies OWNER TO pertexo_owner;

--
-- Name: workflow_version_promotions; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_version_promotions (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    version_id uuid NOT NULL,
    source_workspace_id uuid NOT NULL,
    source_workflow_id uuid NOT NULL,
    source_version_id uuid NOT NULL,
    source_checksum character varying(82) NOT NULL,
    promotion_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT version_promotion_checksum_valid CHECK (((source_checksum)::text ~ '^wf:sha256:(v2:)?[a-f0-9]{64}$'::text))
);


ALTER TABLE app.workflow_version_promotions OWNER TO pertexo_owner;

--
-- Name: workflow_versions; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflow_versions (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    version_number integer NOT NULL,
    graph_json json NOT NULL,
    checksum character varying(77) NOT NULL,
    executable_json json NOT NULL,
    published_by uuid NOT NULL,
    published_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workflow_versions_checksum_format CHECK (((checksum)::text ~ '^wf:sha256:(v2:)?[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_versions_executable_object CHECK (((json_typeof(executable_json) = 'object'::text) AND (octet_length((executable_json)::text) <= 1048576))),
    CONSTRAINT workflow_versions_graph_bounded CHECK ((octet_length((graph_json)::text) <= 2097152)),
    CONSTRAINT workflow_versions_graph_object CHECK ((json_typeof(graph_json) = 'object'::text)),
    CONSTRAINT workflow_versions_number_positive CHECK ((version_number > 0))
);


ALTER TABLE app.workflow_versions OWNER TO pertexo_owner;

--
-- Name: workflows; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workflows (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name character varying(128) NOT NULL,
    name_revision integer DEFAULT 1 NOT NULL,
    lifecycle_status character varying(32) DEFAULT 'active'::character varying NOT NULL,
    lifecycle_revision integer DEFAULT 1 NOT NULL,
    activation_status character varying(32) DEFAULT 'inactive'::character varying NOT NULL,
    published_version_id uuid,
    auto_pause_enabled boolean DEFAULT true NOT NULL,
    auto_pause_threshold smallint,
    auto_pause_settings_revision integer DEFAULT 1 NOT NULL,
    trigger_pause_state character varying(16) DEFAULT 'none'::character varying NOT NULL,
    trigger_paused_at timestamp with time zone,
    trigger_pause_reason character varying(32),
    trigger_pause_failures integer,
    trigger_pause_last_run_id uuid,
    trigger_pause_revision bigint DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT date_trunc('milliseconds'::text, clock_timestamp()) NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflows_activation_status_valid CHECK (((activation_status)::text = ANY (ARRAY[('inactive'::character varying)::text, ('activating'::character varying)::text, ('active'::character varying)::text, ('deactivating'::character varying)::text, ('degraded'::character varying)::text, ('error'::character varying)::text]))),
    CONSTRAINT workflows_auto_pause_settings_revision_check CHECK ((auto_pause_settings_revision > 0)),
    CONSTRAINT workflows_auto_pause_threshold_valid CHECK (((auto_pause_threshold IS NULL) OR ((auto_pause_threshold >= 3) AND (auto_pause_threshold <= 100)))),
    CONSTRAINT workflows_created_at_millisecond_precision CHECK ((created_at = date_trunc('milliseconds'::text, created_at))),
    CONSTRAINT workflows_lifecycle_revision_positive CHECK ((lifecycle_revision > 0)),
    CONSTRAINT workflows_lifecycle_status_valid CHECK (((lifecycle_status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text]))),
    CONSTRAINT workflows_name_nonempty CHECK (((length(btrim((name)::text)) >= 1) AND (length(btrim((name)::text)) <= 128))),
    CONSTRAINT workflows_name_revision_positive CHECK ((name_revision > 0)),
    CONSTRAINT workflows_trigger_pause_valid CHECK ((((trigger_pause_revision > 0) AND ((((trigger_pause_state)::text = 'none'::text) AND (trigger_paused_at IS NULL) AND (trigger_pause_reason IS NULL) AND (trigger_pause_failures IS NULL) AND (trigger_pause_last_run_id IS NULL)) OR (((trigger_pause_state)::text = 'paused'::text) AND (trigger_paused_at IS NOT NULL) AND (trigger_pause_reason IS NOT NULL) AND ((trigger_pause_reason)::text = 'consecutive_failures'::text) AND (trigger_pause_failures IS NOT NULL) AND (trigger_pause_failures > 0) AND (trigger_pause_last_run_id IS NOT NULL)))) IS TRUE))
);


ALTER TABLE app.workflows OWNER TO pertexo_owner;

--
-- Name: workspace_artifact_capacity; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_artifact_capacity (
    workspace_id uuid NOT NULL,
    byte_limit bigint DEFAULT 1073741824 NOT NULL,
    artifact_count_limit integer DEFAULT app.instance_artifact_count_limit() NOT NULL,
    charged_bytes bigint DEFAULT 0 NOT NULL,
    charged_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_artifact_capacity_byte_limit_valid CHECK ((byte_limit >= 0)),
    CONSTRAINT workspace_artifact_capacity_charged_bytes_valid CHECK ((charged_bytes >= 0)),
    CONSTRAINT workspace_artifact_capacity_charged_count_valid CHECK ((charged_count >= 0)),
    CONSTRAINT workspace_artifact_capacity_count_limit_valid CHECK ((artifact_count_limit >= 0))
);


ALTER TABLE app.workspace_artifact_capacity OWNER TO pertexo_owner;

--
-- Name: workspace_creation_idempotency_records; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_creation_idempotency_records (
    id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    operation character varying(64) NOT NULL,
    key_hash character(64) NOT NULL,
    request_hash character(64) NOT NULL,
    status character varying(16) NOT NULL,
    resource_id uuid,
    result_ref jsonb DEFAULT '{}'::jsonb NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '24:00:00'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_creation_idempotency_completed_result CHECK ((((status)::text <> 'completed'::text) OR ((resource_id IS NOT NULL) AND (result_ref <> '{}'::jsonb)))),
    CONSTRAINT workspace_creation_idempotency_expiry_valid CHECK ((expires_at > created_at)),
    CONSTRAINT workspace_creation_idempotency_key_hash_format CHECK ((key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workspace_creation_idempotency_operation_format CHECK (((operation)::text ~ '^[a-z][a-z0-9.]{0,63}$'::text)),
    CONSTRAINT workspace_creation_idempotency_request_hash_format CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workspace_creation_idempotency_result_ref_bounded CHECK ((octet_length((result_ref)::text) <= 4096)),
    CONSTRAINT workspace_creation_idempotency_status_valid CHECK (((status)::text = ANY (ARRAY[('in_progress'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text])))
);


ALTER TABLE app.workspace_creation_idempotency_records OWNER TO pertexo_owner;

--
-- Name: workspace_data_table_quotas; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_data_table_quotas (
    workspace_id uuid NOT NULL,
    table_limit integer DEFAULT 20 NOT NULL,
    column_limit integer DEFAULT 20 NOT NULL,
    row_limit integer DEFAULT 10000 NOT NULL,
    byte_limit integer DEFAULT 52428800 NOT NULL,
    table_count integer DEFAULT 0 NOT NULL,
    stored_bytes integer DEFAULT 0 NOT NULL,
    CONSTRAINT data_table_quotas_bounds CHECK ((((table_limit >= 1) AND (table_limit <= 100)) AND ((column_limit >= 1) AND (column_limit <= 50)) AND ((row_limit >= 1) AND (row_limit <= 100000)) AND ((byte_limit >= 65536) AND (byte_limit <= 1073741824)) AND ((table_count >= 0) AND (table_count <= table_limit)) AND ((stored_bytes >= 0) AND (stored_bytes <= byte_limit))))
);


ALTER TABLE app.workspace_data_table_quotas OWNER TO pertexo_owner;

--
-- Name: workspace_data_table_rows; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_data_table_rows (
    workspace_id uuid NOT NULL,
    table_id uuid NOT NULL,
    id uuid NOT NULL,
    values_json text NOT NULL,
    key_value text,
    revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT workspace_data_table_rows_bounds CHECK (((octet_length(values_json) <= 65536) AND (jsonb_typeof((values_json)::jsonb) = 'object'::text) AND ((key_value IS NULL) OR (octet_length(key_value) <= 1024)) AND (revision > 0)))
);


ALTER TABLE app.workspace_data_table_rows OWNER TO pertexo_owner;

--
-- Name: workspace_data_tables; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_data_tables (
    workspace_id uuid NOT NULL,
    id uuid NOT NULL,
    name character varying(64) NOT NULL,
    columns_json jsonb NOT NULL,
    key_column character varying(64),
    row_count integer DEFAULT 0 NOT NULL,
    stored_bytes integer DEFAULT 0 NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    has_removed_columns boolean DEFAULT false NOT NULL,
    CONSTRAINT workspace_data_tables_bounds CHECK ((((name)::text ~ '^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,62}[A-Za-z0-9_-])?$'::text) AND (jsonb_typeof(columns_json) = 'array'::text) AND ((jsonb_array_length(columns_json) >= 1) AND (jsonb_array_length(columns_json) <= 50)) AND (octet_length((columns_json)::text) <= 16384) AND ((row_count >= 0) AND (row_count <= 100000)) AND (stored_bytes >= 0) AND (revision > 0)))
);


ALTER TABLE app.workspace_data_tables OWNER TO pertexo_owner;

--
-- Name: workspace_execution_admission_counters; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_execution_admission_counters (
    workspace_id uuid NOT NULL,
    queued_runs integer DEFAULT 0 NOT NULL,
    active_runs integer DEFAULT 0 NOT NULL,
    reconciled_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_execution_admission_counters_nonnegative CHECK (((queued_runs >= 0) AND (active_runs >= 0)))
);


ALTER TABLE app.workspace_execution_admission_counters OWNER TO pertexo_owner;

--
-- Name: workspace_execution_entitlement_versions; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_execution_entitlement_versions (
    workspace_id uuid NOT NULL,
    version integer NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    active_run_limit integer CONSTRAINT workspace_execution_entitlement_versi_active_run_limit_not_null NOT NULL,
    queued_run_limit integer CONSTRAINT workspace_execution_entitlement_versi_queued_run_limit_not_null NOT NULL,
    effective_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_execution_entitlement_versions_limits_valid CHECK (((active_run_limit >= 1) AND (active_run_limit <= 10000) AND ((queued_run_limit >= 1) AND (queued_run_limit <= 100000)))),
    CONSTRAINT workspace_execution_entitlement_versions_status_valid CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text]))),
    CONSTRAINT workspace_execution_entitlement_versions_time_valid CHECK (((expires_at IS NULL) OR (expires_at > effective_at))),
    CONSTRAINT workspace_execution_entitlement_versions_version_positive CHECK ((version > 0))
);


ALTER TABLE app.workspace_execution_entitlement_versions OWNER TO pertexo_owner;

--
-- Name: workspace_execution_entitlements; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_execution_entitlements (
    workspace_id uuid NOT NULL,
    current_version integer NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


ALTER TABLE app.workspace_execution_entitlements OWNER TO pertexo_owner;

--
-- Name: workspace_inbox_events; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_inbox_events (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    run_id uuid NOT NULL,
    terminal_event_sequence bigint NOT NULL,
    kind character varying(32) NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_inbox_events_kind_check CHECK (((kind)::text = ANY (ARRAY[('failed'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text]))),
    CONSTRAINT workspace_inbox_events_terminal_event_sequence_check CHECK ((terminal_event_sequence > 0))
);


ALTER TABLE app.workspace_inbox_events OWNER TO pertexo_owner;

--
-- Name: workspace_inbox_failure_days; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_inbox_failure_days (
    workspace_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    day date NOT NULL,
    count bigint NOT NULL,
    CONSTRAINT workspace_inbox_failure_days_count_positive CHECK ((count > 0))
);


ALTER TABLE app.workspace_inbox_failure_days OWNER TO pertexo_owner;

--
-- Name: workspace_inbox_reads; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_inbox_reads (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    read_revision bigint NOT NULL,
    read_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    thread_id uuid NOT NULL,
    CONSTRAINT workspace_inbox_reads_read_revision_check CHECK ((read_revision > 0))
);


ALTER TABLE app.workspace_inbox_reads OWNER TO pertexo_owner;

--
-- Name: workspace_inbox_revision_seq; Type: SEQUENCE; Schema: app; Owner: pertexo_owner
--

CREATE SEQUENCE app.workspace_inbox_revision_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE app.workspace_inbox_revision_seq OWNER TO pertexo_owner;

--
-- Name: workspace_inbox_threads; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_inbox_threads (
    workspace_id uuid NOT NULL,
    workflow_id uuid,
    revision bigint NOT NULL,
    occurrence_count bigint NOT NULL,
    first_occurred_at timestamp with time zone NOT NULL,
    latest_occurred_at timestamp with time zone NOT NULL,
    latest_run_id uuid,
    latest_kind character varying(32),
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    id uuid NOT NULL,
    notice_kind character varying(32) NOT NULL,
    subject_id uuid NOT NULL,
    connection_id uuid,
    task_id uuid,
    active boolean DEFAULT true NOT NULL,
    source_revision character varying(128),
    capacity_limit character varying(16),
    publication_request_id uuid,
    comment_mention_id uuid,
    CONSTRAINT workspace_inbox_threads_failure_valid CHECK ((((((notice_kind)::text = 'workflow_failure'::text) AND (latest_run_id IS NOT NULL) AND (latest_kind IS NOT NULL)) OR (((notice_kind)::text <> 'workflow_failure'::text) AND (latest_run_id IS NULL) AND (latest_kind IS NULL))) IS TRUE)),
    CONSTRAINT workspace_inbox_threads_latest_kind_check CHECK (((latest_kind)::text = ANY (ARRAY[('failed'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text]))),
    CONSTRAINT workspace_inbox_threads_occurrence_count_check CHECK ((occurrence_count > 0)),
    CONSTRAINT workspace_inbox_threads_occurrence_order CHECK ((latest_occurred_at >= first_occurred_at)),
    CONSTRAINT workspace_inbox_threads_revision_check CHECK ((revision > 0)),
    CONSTRAINT workspace_inbox_threads_subject_valid CHECK ((((((((notice_kind)::text = 'publication_review_waiting'::text) AND (publication_request_id = subject_id) AND (workflow_id IS NOT NULL) AND (connection_id IS NULL) AND (task_id IS NULL) AND (capacity_limit IS NULL)) OR ((publication_request_id IS NULL) AND ((((notice_kind)::text = 'limit_approaching'::text) AND (subject_id = id) AND ((capacity_limit)::text = ANY ((ARRAY['active'::character varying, 'queue'::character varying, 'artifact_bytes'::character varying, 'artifact_count'::character varying])::text[])) AND (workflow_id IS NULL) AND (connection_id IS NULL) AND (task_id IS NULL)) OR ((capacity_limit IS NULL) AND ((((notice_kind)::text = ANY ((ARRAY['workflow_failure'::character varying, 'workflow_auto_paused'::character varying])::text[])) AND (workflow_id = subject_id) AND (connection_id IS NULL) AND (task_id IS NULL)) OR (((notice_kind)::text = 'connection_attention'::text) AND (connection_id = subject_id) AND (workflow_id IS NULL) AND (task_id IS NULL)) OR (((notice_kind)::text = 'approval_waiting'::text) AND (task_id = subject_id) AND (workflow_id IS NOT NULL) AND (connection_id IS NULL)) OR (((notice_kind)::text = 'limit_reached'::text) AND (subject_id = workspace_id) AND (workflow_id IS NULL) AND (connection_id IS NULL) AND (task_id IS NULL)) OR (((notice_kind)::text = 'failure_alert_attention'::text) AND (workflow_id IS NULL) AND (connection_id IS NULL) AND (task_id IS NULL))))))) AND (comment_mention_id IS NULL)) OR (((notice_kind)::text = 'workflow_mention'::text) AND (comment_mention_id = subject_id) AND (workflow_id IS NOT NULL) AND (connection_id IS NULL) AND (task_id IS NULL) AND (publication_request_id IS NULL) AND (capacity_limit IS NULL))) IS TRUE))
);


ALTER TABLE app.workspace_inbox_threads OWNER TO pertexo_owner;

--
-- Name: workspace_invitation_acceptance_intents; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_invitation_acceptance_intents (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    invitation_id uuid NOT NULL,
    invitation_revision integer CONSTRAINT workspace_invitation_acceptance_in_invitation_revision_not_null NOT NULL,
    binding_digest character(64) NOT NULL,
    csrf_digest character(64) NOT NULL,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    verified_user_id uuid,
    verified_email character varying(320),
    verified_at timestamp with time zone,
    accepted_user_id uuid,
    receipt jsonb,
    expires_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    abandoned_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    verified_session_id uuid,
    CONSTRAINT workspace_invitation_intents_completion_shape CHECK (((((status)::text = 'completed'::text) AND (accepted_user_id IS NOT NULL) AND (receipt IS NOT NULL) AND (completed_at IS NOT NULL)) OR (((status)::text <> 'completed'::text) AND (accepted_user_id IS NULL) AND (receipt IS NULL) AND (completed_at IS NULL)))),
    CONSTRAINT workspace_invitation_intents_digests_valid CHECK (((binding_digest ~ '^[0-9a-f]{64}$'::text) AND (csrf_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT workspace_invitation_intents_revision_positive CHECK ((invitation_revision > 0)),
    CONSTRAINT workspace_invitation_intents_status_valid CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('verified'::character varying)::text, ('wrong_account'::character varying)::text, ('completed'::character varying)::text, ('abandoned'::character varying)::text, ('superseded'::character varying)::text]))),
    CONSTRAINT workspace_invitation_intents_verification_shape CHECK ((((verified_user_id IS NULL) AND (verified_email IS NULL) AND (verified_at IS NULL)) OR ((verified_user_id IS NOT NULL) AND (verified_email IS NOT NULL) AND (verified_at IS NOT NULL))))
);


ALTER TABLE app.workspace_invitation_acceptance_intents OWNER TO pertexo_owner;

--
-- Name: workspace_invitation_binding_replacement_claims; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_invitation_binding_replacement_claims (
    prior_workspace_id uuid CONSTRAINT workspace_invitation_binding_replac_prior_workspace_id_not_null NOT NULL,
    prior_intent_id uuid CONSTRAINT workspace_invitation_binding_replaceme_prior_intent_id_not_null NOT NULL,
    prior_binding_digest character(64) CONSTRAINT workspace_invitation_binding_repl_prior_binding_digest_not_null NOT NULL,
    successor_workspace_id uuid CONSTRAINT workspace_invitation_binding_re_successor_workspace_id_not_null NOT NULL,
    successor_intent_id uuid CONSTRAINT workspace_invitation_binding_repla_successor_intent_id_not_null NOT NULL,
    successor_invitation_id uuid CONSTRAINT workspace_invitation_binding_r_successor_invitation_id_not_null NOT NULL,
    successor_invitation_revision integer CONSTRAINT workspace_invitation_bindin_successor_invitation_revis_not_null NOT NULL,
    successor_binding_digest character(64) CONSTRAINT workspace_invitation_binding__successor_binding_digest_not_null NOT NULL,
    successor_csrf_digest character(64) CONSTRAINT workspace_invitation_binding_rep_successor_csrf_digest_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() CONSTRAINT workspace_invitation_binding_replacement_cl_created_at_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() CONSTRAINT workspace_invitation_binding_replacement_cl_updated_at_not_null NOT NULL,
    CONSTRAINT workspace_invitation_binding_replacement_claims_check CHECK (((prior_binding_digest ~ '^[0-9a-f]{64}$'::text) AND (successor_binding_digest ~ '^[0-9a-f]{64}$'::text) AND (successor_csrf_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT workspace_invitation_binding_successor_invitation_revisio_check CHECK ((successor_invitation_revision > 0))
);


ALTER TABLE app.workspace_invitation_binding_replacement_claims OWNER TO pertexo_owner;

--
-- Name: workspace_invitation_delivery_attempts; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_invitation_delivery_attempts (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    invitation_id uuid NOT NULL,
    invitation_revision integer CONSTRAINT workspace_invitation_delivery_atte_invitation_revision_not_null NOT NULL,
    status character varying(32) DEFAULT 'queued'::character varying NOT NULL,
    token_ciphertext text,
    token_nonce character varying(128),
    token_tag character varying(256),
    token_key_version character varying(64),
    workspace_name character varying(256) NOT NULL,
    provider_reference character varying(512),
    failure_code character varying(128),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_invitation_delivery_revision_positive CHECK ((invitation_revision > 0)),
    CONSTRAINT workspace_invitation_delivery_sealed_shape CHECK ((((token_ciphertext IS NULL) AND (token_nonce IS NULL) AND (token_tag IS NULL) AND (token_key_version IS NULL)) OR ((token_ciphertext IS NOT NULL) AND (token_nonce IS NOT NULL) AND (token_tag IS NOT NULL) AND (token_key_version IS NOT NULL)))),
    CONSTRAINT workspace_invitation_delivery_status_valid CHECK (((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('submitted'::character varying)::text, ('failed'::character varying)::text, ('unknown'::character varying)::text, ('canceled'::character varying)::text])))
);


ALTER TABLE app.workspace_invitation_delivery_attempts OWNER TO pertexo_owner;

--
-- Name: workspace_invitations; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_invitations (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    recipient_email character varying(320) NOT NULL,
    normalized_email character varying(320) NOT NULL,
    role character varying(32) NOT NULL,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    token_digest character(64) NOT NULL,
    delivery_status character varying(32) DEFAULT 'queued'::character varying NOT NULL,
    created_by uuid NOT NULL,
    accepted_by uuid,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_invitations_delivery_status_valid CHECK (((delivery_status)::text = ANY (ARRAY[('queued'::character varying)::text, ('submitted'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('unknown'::character varying)::text]))),
    CONSTRAINT workspace_invitations_normalized_email_valid CHECK (((normalized_email)::text = lower(btrim((recipient_email)::text)))),
    CONSTRAINT workspace_invitations_revision_positive CHECK ((revision > 0)),
    CONSTRAINT workspace_invitations_role_valid CHECK (((role)::text = ANY (ARRAY[('admin'::character varying)::text, ('builder'::character varying)::text, ('operator'::character varying)::text, ('viewer'::character varying)::text]))),
    CONSTRAINT workspace_invitations_status_valid CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('accepted'::character varying)::text, ('revoked'::character varying)::text, ('expired'::character varying)::text]))),
    CONSTRAINT workspace_invitations_terminal_shape CHECK (((((status)::text = 'accepted'::text) AND (accepted_by IS NOT NULL) AND (accepted_at IS NOT NULL) AND (revoked_at IS NULL)) OR (((status)::text = 'revoked'::text) AND (accepted_by IS NULL) AND (accepted_at IS NULL) AND (revoked_at IS NOT NULL)) OR (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('expired'::character varying)::text])) AND (accepted_by IS NULL) AND (accepted_at IS NULL) AND (revoked_at IS NULL)))),
    CONSTRAINT workspace_invitations_token_digest_valid CHECK ((token_digest ~ '^[0-9a-f]{64}$'::text))
);


ALTER TABLE app.workspace_invitations OWNER TO pertexo_owner;

--
-- Name: workspace_lifecycle_operations; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_lifecycle_operations (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    idempotency_key_hash character(64) NOT NULL,
    command_type character varying(32) NOT NULL,
    actor_user_id uuid NOT NULL,
    reason character varying(512) NOT NULL,
    request_hash character(64) NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_lifecycle_operations_command_valid CHECK (((command_type)::text = ANY (ARRAY[('deletion_requested'::character varying)::text, ('deletion_restored'::character varying)::text, ('reactivated'::character varying)::text]))),
    CONSTRAINT workspace_lifecycle_operations_idempotency_hash_valid CHECK ((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workspace_lifecycle_operations_reason_bounded CHECK (((length(btrim((reason)::text)) >= 1) AND (length(btrim((reason)::text)) <= 512))),
    CONSTRAINT workspace_lifecycle_operations_request_hash_valid CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text))
);


ALTER TABLE app.workspace_lifecycle_operations OWNER TO pertexo_owner;

--
-- Name: workspace_memberships; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_memberships (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role character varying(32) NOT NULL,
    role_revision integer DEFAULT 1 NOT NULL,
    status character varying(32) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_memberships_role_revision_positive CHECK ((role_revision > 0)),
    CONSTRAINT workspace_memberships_role_valid CHECK (((role)::text = ANY (ARRAY[('owner'::character varying)::text, ('admin'::character varying)::text, ('builder'::character varying)::text, ('operator'::character varying)::text, ('viewer'::character varying)::text]))),
    CONSTRAINT workspace_memberships_status_valid CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text, ('removed'::character varying)::text])))
);


ALTER TABLE app.workspace_memberships OWNER TO pertexo_owner;

--
-- Name: workspace_promotion_targets; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_promotion_targets (
    workspace_id uuid NOT NULL,
    target_workspace_id uuid,
    revision integer DEFAULT 1 NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT promotion_target_distinct CHECK ((workspace_id <> target_workspace_id)),
    CONSTRAINT promotion_target_revision_positive CHECK ((revision > 0))
);


ALTER TABLE app.workspace_promotion_targets OWNER TO pertexo_owner;

--
-- Name: workspace_variable_set_revisions; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_variable_set_revisions (
    workspace_id uuid NOT NULL,
    revision integer NOT NULL,
    values_json jsonb NOT NULL,
    descriptions_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_variable_sets_descriptions_bounded CHECK (((jsonb_typeof(descriptions_json) = 'object'::text) AND (octet_length((descriptions_json)::text) <= 32768))),
    CONSTRAINT workspace_variable_sets_revision_positive CHECK ((revision > 0)),
    CONSTRAINT workspace_variable_sets_values_bounded CHECK (((jsonb_typeof(values_json) = 'object'::text) AND (octet_length((values_json)::text) <= 65536)))
);


ALTER TABLE app.workspace_variable_set_revisions OWNER TO pertexo_owner;

--
-- Name: workspace_variables; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspace_variables (
    workspace_id uuid NOT NULL,
    revision integer NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_variables_revision_positive CHECK ((revision > 0))
);


ALTER TABLE app.workspace_variables OWNER TO pertexo_owner;

--
-- Name: workspaces; Type: TABLE; Schema: app; Owner: pertexo_owner
--

CREATE TABLE app.workspaces (
    id uuid NOT NULL,
    name character varying(128) NOT NULL,
    slug character varying(64) NOT NULL,
    status character varying(32) DEFAULT 'active'::character varying NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_by uuid,
    deletion_requested_at timestamp with time zone,
    deletion_requested_by uuid,
    deletion_reason character varying(512),
    purge_after timestamp with time zone,
    auto_pause_threshold smallint DEFAULT 10 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    audit_retention_days smallint DEFAULT 365 NOT NULL,
    governance_revision integer DEFAULT 1 NOT NULL,
    require_publish_approval boolean DEFAULT false NOT NULL,
    CONSTRAINT workspaces_audit_retention_valid CHECK (((audit_retention_days >= 30) AND (audit_retention_days <= 2555))),
    CONSTRAINT workspaces_auto_pause_threshold_valid CHECK (((auto_pause_threshold >= 3) AND (auto_pause_threshold <= 100))),
    CONSTRAINT workspaces_deletion_state_valid CHECK (((((status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text])) AND (created_by IS NOT NULL) AND (deletion_requested_at IS NULL) AND (deletion_requested_by IS NULL) AND (deletion_reason IS NULL) AND (purge_after IS NULL)) OR (((status)::text = ANY (ARRAY[('pending_deletion'::character varying)::text, ('purging'::character varying)::text])) AND (created_by IS NOT NULL) AND (deletion_requested_at IS NOT NULL) AND (deletion_requested_by IS NOT NULL) AND (deletion_reason IS NOT NULL) AND ((length(btrim((deletion_reason)::text)) >= 1) AND (length(btrim((deletion_reason)::text)) <= 512)) AND (purge_after IS NOT NULL) AND (purge_after > deletion_requested_at)) OR (((status)::text = 'deleted'::text) AND (created_by IS NULL) AND (deletion_requested_at IS NOT NULL) AND (deletion_requested_by IS NULL) AND ((deletion_reason)::text = 'purged'::text) AND (purge_after IS NOT NULL) AND (purge_after > deletion_requested_at) AND ((name)::text = 'Deleted workspace'::text) AND ((slug)::text = ('deleted-'::text || (id)::text))))),
    CONSTRAINT workspaces_governance_revision_positive CHECK ((governance_revision > 0)),
    CONSTRAINT workspaces_name_nonempty CHECK (((length(btrim((name)::text)) >= 1) AND (length(btrim((name)::text)) <= 128))),
    CONSTRAINT workspaces_revision_positive CHECK ((revision > 0)),
    CONSTRAINT workspaces_slug_format CHECK (((slug)::text ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'::text)),
    CONSTRAINT workspaces_status_valid CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text, ('pending_deletion'::character varying)::text, ('purging'::character varying)::text, ('deleted'::character varying)::text])))
);


ALTER TABLE app.workspaces OWNER TO pertexo_owner;

--
-- Name: schema_migrations; Type: TABLE; Schema: pertexo_internal; Owner: pertexo_owner
--

CREATE TABLE pertexo_internal.schema_migrations (
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE pertexo_internal.schema_migrations OWNER TO pertexo_owner;

--
-- Name: write_probe; Type: TABLE; Schema: pertexo_internal; Owner: pertexo_owner
--

CREATE TABLE pertexo_internal.write_probe (
    checked_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE pertexo_internal.write_probe OWNER TO pertexo_owner;

--
-- Name: api_tokens api_tokens_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.api_tokens
    ADD CONSTRAINT api_tokens_pkey PRIMARY KEY (id);


--
-- Name: artifact_links artifact_links_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.artifact_links
    ADD CONSTRAINT artifact_links_identity_unique PRIMARY KEY (workspace_id, artifact_id, owner_kind, owner_id);


--
-- Name: artifact_owner_references artifact_owner_references_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.artifact_owner_references
    ADD CONSTRAINT artifact_owner_references_pkey PRIMARY KEY (workspace_id, artifact_id, owner_family, owner_id, owner_sub_id, owner_slot);


--
-- Name: artifacts artifacts_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);


--
-- Name: artifacts artifacts_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.artifacts
    ADD CONSTRAINT artifacts_workspace_identity_unique UNIQUE (workspace_id, id);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);


--
-- Name: auth_accounts auth_accounts_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_accounts
    ADD CONSTRAINT auth_accounts_pkey PRIMARY KEY (id);


--
-- Name: auth_accounts auth_accounts_provider_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_accounts
    ADD CONSTRAINT auth_accounts_provider_identity_unique UNIQUE (provider_id, account_id);


--
-- Name: auth_directory_group_mappings auth_directory_group_mapping_priority_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_group_mappings
    ADD CONSTRAINT auth_directory_group_mapping_priority_unique UNIQUE (organization_id, workspace_id, priority);


--
-- Name: auth_directory_group_mappings auth_directory_group_mappings_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_group_mappings
    ADD CONSTRAINT auth_directory_group_mappings_pkey PRIMARY KEY (organization_id, workspace_id, group_id);


--
-- Name: auth_directory_group_members auth_directory_group_members_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_group_members
    ADD CONSTRAINT auth_directory_group_members_pkey PRIMARY KEY (organization_id, group_id, directory_user_id);


--
-- Name: auth_directory_groups auth_directory_group_org_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_groups
    ADD CONSTRAINT auth_directory_group_org_identity_unique UNIQUE (organization_id, id);


--
-- Name: auth_directory_groups auth_directory_groups_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_groups
    ADD CONSTRAINT auth_directory_groups_pkey PRIMARY KEY (id);


--
-- Name: auth_directory_memberships auth_directory_memberships_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_memberships
    ADD CONSTRAINT auth_directory_memberships_pkey PRIMARY KEY (workspace_id, user_id);


--
-- Name: auth_directory_users auth_directory_user_binding_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_users
    ADD CONSTRAINT auth_directory_user_binding_identity_unique UNIQUE (organization_id, id, user_id);


--
-- Name: auth_directory_users auth_directory_user_org_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_users
    ADD CONSTRAINT auth_directory_user_org_identity_unique UNIQUE (organization_id, id);


--
-- Name: auth_directory_users auth_directory_users_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_users
    ADD CONSTRAINT auth_directory_users_pkey PRIMARY KEY (id);


--
-- Name: auth_domains auth_domain_organization_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_domains
    ADD CONSTRAINT auth_domain_organization_identity_unique UNIQUE (organization_id, id);


--
-- Name: auth_domains auth_domain_organization_name_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_domains
    ADD CONSTRAINT auth_domain_organization_name_unique UNIQUE (organization_id, domain);


--
-- Name: auth_domains auth_domains_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_domains
    ADD CONSTRAINT auth_domains_pkey PRIMARY KEY (id);


--
-- Name: auth_email_proofs auth_email_proofs_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_email_proofs
    ADD CONSTRAINT auth_email_proofs_pkey PRIMARY KEY (id);


--
-- Name: auth_email_proofs auth_email_proofs_token_digest_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_email_proofs
    ADD CONSTRAINT auth_email_proofs_token_digest_key UNIQUE (token_digest);


--
-- Name: auth_federation_attempts auth_federation_attempt_state_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_federation_attempts
    ADD CONSTRAINT auth_federation_attempt_state_unique UNIQUE (state_digest);


--
-- Name: auth_federation_attempts auth_federation_attempts_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_federation_attempts
    ADD CONSTRAINT auth_federation_attempts_pkey PRIMARY KEY (id);


--
-- Name: auth_method_link_attempts auth_method_link_attempts_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_method_link_attempts
    ADD CONSTRAINT auth_method_link_attempts_pkey PRIMARY KEY (id);


--
-- Name: auth_method_link_attempts auth_method_link_attempts_state_digest_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_method_link_attempts
    ADD CONSTRAINT auth_method_link_attempts_state_digest_key UNIQUE (state_digest);


--
-- Name: auth_organizations auth_organization_control_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_organizations
    ADD CONSTRAINT auth_organization_control_unique UNIQUE (control_workspace_id);


--
-- Name: auth_organization_workspaces auth_organization_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_organization_workspaces
    ADD CONSTRAINT auth_organization_workspace_identity_unique UNIQUE (organization_id, workspace_id);


--
-- Name: auth_organization_workspaces auth_organization_workspaces_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_organization_workspaces
    ADD CONSTRAINT auth_organization_workspaces_pkey PRIMARY KEY (workspace_id);


--
-- Name: auth_organizations auth_organizations_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_organizations
    ADD CONSTRAINT auth_organizations_pkey PRIMARY KEY (id);


--
-- Name: auth_provider_checks auth_provider_checks_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_provider_checks
    ADD CONSTRAINT auth_provider_checks_pkey PRIMARY KEY (organization_id, domain_id, provider_id);


--
-- Name: auth_providers auth_provider_organization_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_providers
    ADD CONSTRAINT auth_provider_organization_identity_unique UNIQUE (organization_id, id);


--
-- Name: auth_providers auth_providers_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_providers
    ADD CONSTRAINT auth_providers_pkey PRIMARY KEY (id);


--
-- Name: auth_provisioning_credentials auth_provisioning_credential_digest_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_provisioning_credentials
    ADD CONSTRAINT auth_provisioning_credential_digest_unique UNIQUE (organization_id, secret_digest);


--
-- Name: auth_provisioning_credentials auth_provisioning_credentials_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_provisioning_credentials
    ADD CONSTRAINT auth_provisioning_credentials_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions auth_sessions_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions auth_sessions_token_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_sessions
    ADD CONSTRAINT auth_sessions_token_key UNIQUE (token);


--
-- Name: auth_sign_in_attempts auth_sign_in_attempts_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_sign_in_attempts
    ADD CONSTRAINT auth_sign_in_attempts_pkey PRIMARY KEY (id);


--
-- Name: auth_sign_in_attempts auth_sign_in_state_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_sign_in_attempts
    ADD CONSTRAINT auth_sign_in_state_unique UNIQUE (state_digest);


--
-- Name: auth_two_factors auth_two_factors_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_two_factors
    ADD CONSTRAINT auth_two_factors_pkey PRIMARY KEY (id);


--
-- Name: auth_two_factors auth_two_factors_user_id_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_two_factors
    ADD CONSTRAINT auth_two_factors_user_id_unique UNIQUE (user_id);


--
-- Name: auth_verifications auth_verifications_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_verifications
    ADD CONSTRAINT auth_verifications_pkey PRIMARY KEY (id);


--
-- Name: connection_events connection_events_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_events
    ADD CONSTRAINT connection_events_pkey PRIMARY KEY (id);


--
-- Name: connection_health_observations connection_health_observations_attempt_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_health_observations
    ADD CONSTRAINT connection_health_observations_attempt_unique UNIQUE (workspace_id, attempt_id);


--
-- Name: connection_health_observations connection_health_observations_outbox_event_id_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_health_observations
    ADD CONSTRAINT connection_health_observations_outbox_event_id_key UNIQUE (outbox_event_id);


--
-- Name: connection_health_observations connection_health_observations_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_health_observations
    ADD CONSTRAINT connection_health_observations_pkey PRIMARY KEY (id);


--
-- Name: connection_oauth2_authorizations connection_oauth2_authorizations_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_oauth2_authorizations
    ADD CONSTRAINT connection_oauth2_authorizations_pkey PRIMARY KEY (workspace_id, connection_id);


--
-- Name: connection_oauth2_authorizations connection_oauth2_authorizations_state_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_oauth2_authorizations
    ADD CONSTRAINT connection_oauth2_authorizations_state_unique UNIQUE (workspace_id, state_digest);


--
-- Name: connection_oauth2_clients connection_oauth2_clients_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_oauth2_clients
    ADD CONSTRAINT connection_oauth2_clients_pkey PRIMARY KEY (workspace_id, connection_id, secret_version_id);


--
-- Name: connection_oauth2_tokens connection_oauth2_tokens_one_per_connection; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_oauth2_tokens
    ADD CONSTRAINT connection_oauth2_tokens_one_per_connection UNIQUE (workspace_id, connection_id);


--
-- Name: connection_oauth2_tokens connection_oauth2_tokens_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_oauth2_tokens
    ADD CONSTRAINT connection_oauth2_tokens_pkey PRIMARY KEY (id);


--
-- Name: connection_secret_versions connection_secret_versions_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_secret_versions
    ADD CONSTRAINT connection_secret_versions_pkey PRIMARY KEY (id);


--
-- Name: connection_secret_versions connection_secret_versions_workspace_connection_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_secret_versions
    ADD CONSTRAINT connection_secret_versions_workspace_connection_identity_unique UNIQUE (workspace_id, connection_id, id);


--
-- Name: connection_shares connection_shares_workspace_id_connection_id_user_id_pk; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_shares
    ADD CONSTRAINT connection_shares_workspace_id_connection_id_user_id_pk PRIMARY KEY (workspace_id, connection_id, user_id);


--
-- Name: connections connections_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connections
    ADD CONSTRAINT connections_pkey PRIMARY KEY (id);


--
-- Name: connections connections_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connections
    ADD CONSTRAINT connections_workspace_identity_unique UNIQUE (workspace_id, id);


--
-- Name: data_table_write_receipts data_table_write_receipts_workspace_id_execution_id_invocation_; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.data_table_write_receipts
    ADD CONSTRAINT data_table_write_receipts_workspace_id_execution_id_invocation_ PRIMARY KEY (workspace_id, execution_id, invocation_id);


--
-- Name: failure_notification_destination_versions failure_notification_destination_versions_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.failure_notification_destination_versions
    ADD CONSTRAINT failure_notification_destination_versions_pkey PRIMARY KEY (destination_id, version);


--
-- Name: failure_notification_destination_versions failure_notification_destination_versions_workspace_identity_ef; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.failure_notification_destination_versions
    ADD CONSTRAINT failure_notification_destination_versions_workspace_identity_ef UNIQUE (workspace_id, destination_id, version, side_effect_class);


--
-- Name: failure_notification_destination_versions failure_notification_destination_versions_workspace_identity_un; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.failure_notification_destination_versions
    ADD CONSTRAINT failure_notification_destination_versions_workspace_identity_un UNIQUE (workspace_id, destination_id, version);


--
-- Name: failure_notification_destinations failure_notification_destinations_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.failure_notification_destinations
    ADD CONSTRAINT failure_notification_destinations_pkey PRIMARY KEY (id);


--
-- Name: failure_notification_destinations failure_notification_destinations_workspace_identity_kind_uniqu; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.failure_notification_destinations
    ADD CONSTRAINT failure_notification_destinations_workspace_identity_kind_uniqu UNIQUE (workspace_id, id, kind);


--
-- Name: failure_notification_destinations failure_notification_destinations_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.failure_notification_destinations
    ADD CONSTRAINT failure_notification_destinations_workspace_identity_unique UNIQUE (workspace_id, id);


--
-- Name: form_uploads form_uploads_workspace_id_artifact_id_pk; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.form_uploads
    ADD CONSTRAINT form_uploads_workspace_id_artifact_id_pk PRIMARY KEY (workspace_id, artifact_id);


--
-- Name: idempotency_records idempotency_records_active_key_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.idempotency_records
    ADD CONSTRAINT idempotency_records_active_key_unique UNIQUE (workspace_id, operation, scope, key_hash);


--
-- Name: idempotency_records idempotency_records_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.idempotency_records
    ADD CONSTRAINT idempotency_records_pkey PRIMARY KEY (id);


--
-- Name: identity_security_audit_facts identity_security_audit_facts_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.identity_security_audit_facts
    ADD CONSTRAINT identity_security_audit_facts_pkey PRIMARY KEY (id);


--
-- Name: inbox_receipts inbox_receipts_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.inbox_receipts
    ADD CONSTRAINT inbox_receipts_pkey PRIMARY KEY (consumer_name, message_id);


--
-- Name: instance_capacity instance_capacity_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.instance_capacity
    ADD CONSTRAINT instance_capacity_pkey PRIMARY KEY (singleton);


--
-- Name: node_attempt_connection_dispatches node_attempt_connection_dispatches_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.node_attempt_connection_dispatches
    ADD CONSTRAINT node_attempt_connection_dispatches_pkey PRIMARY KEY (workspace_id, attempt_id);


--
-- Name: node_attempts node_attempts_number_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.node_attempts
    ADD CONSTRAINT node_attempts_number_unique UNIQUE (node_run_id, attempt_number);


--
-- Name: node_attempts node_attempts_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.node_attempts
    ADD CONSTRAINT node_attempts_pkey PRIMARY KEY (id);


--
-- Name: node_attempts node_attempts_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.node_attempts
    ADD CONSTRAINT node_attempts_workspace_identity_unique UNIQUE (workspace_id, id);


--
-- Name: node_runs node_runs_invocation_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.node_runs
    ADD CONSTRAINT node_runs_invocation_unique UNIQUE (workflow_run_id, invocation_key);


--
-- Name: node_runs node_runs_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.node_runs
    ADD CONSTRAINT node_runs_pkey PRIMARY KEY (id);


--
-- Name: node_runs node_runs_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.node_runs
    ADD CONSTRAINT node_runs_workspace_identity_unique UNIQUE (workspace_id, id);


--
-- Name: notice_mail_batches notice_mail_batches_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.notice_mail_batches
    ADD CONSTRAINT notice_mail_batches_pkey PRIMARY KEY (id);


--
-- Name: notice_mail_items notice_mail_items_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.notice_mail_items
    ADD CONSTRAINT notice_mail_items_pkey PRIMARY KEY (workspace_id, batch_id, thread_id);


--
-- Name: notice_preferences notice_preferences_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.notice_preferences
    ADD CONSTRAINT notice_preferences_pkey PRIMARY KEY (workspace_id, user_id);


--
-- Name: notice_subscriptions notice_subscriptions_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.notice_subscriptions
    ADD CONSTRAINT notice_subscriptions_pkey PRIMARY KEY (workspace_id, user_id, subject_kind, subject_id);


--
-- Name: notice_workspace_settings notice_workspace_settings_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.notice_workspace_settings
    ADD CONSTRAINT notice_workspace_settings_pkey PRIMARY KEY (workspace_id);


--
-- Name: operator_commands operator_commands_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.operator_commands
    ADD CONSTRAINT operator_commands_pkey PRIMARY KEY (id);


--
-- Name: operator_run_replay_requests operator_run_replay_requests_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.operator_run_replay_requests
    ADD CONSTRAINT operator_run_replay_requests_pkey PRIMARY KEY (command_id);


--
-- Name: operator_unknown_outcome_evidence operator_unknown_outcome_evidence_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.operator_unknown_outcome_evidence
    ADD CONSTRAINT operator_unknown_outcome_evidence_pkey PRIMARY KEY (command_id);


--
-- Name: outbox_events outbox_events_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (id);


--
-- Name: outbox_fair_dispatch_cursor outbox_fair_dispatch_cursor_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.outbox_fair_dispatch_cursor
    ADD CONSTRAINT outbox_fair_dispatch_cursor_pkey PRIMARY KEY (singleton);


--
-- Name: pending_run_tasks pending_run_tasks_callback_scope_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.pending_run_tasks
    ADD CONSTRAINT pending_run_tasks_callback_scope_unique UNIQUE (workspace_id, run_id, callback_node_id, callback_scope_hash);


--
-- Name: pending_run_tasks pending_run_tasks_callback_token_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.pending_run_tasks
    ADD CONSTRAINT pending_run_tasks_callback_token_unique UNIQUE (callback_token_hash);


--
-- Name: pending_run_tasks pending_run_tasks_invocation_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.pending_run_tasks
    ADD CONSTRAINT pending_run_tasks_invocation_unique UNIQUE (workspace_id, run_id, invocation_key);


--
-- Name: pending_run_tasks pending_run_tasks_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.pending_run_tasks
    ADD CONSTRAINT pending_run_tasks_pkey PRIMARY KEY (id);


--
-- Name: pending_run_tasks pending_run_tasks_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.pending_run_tasks
    ADD CONSTRAINT pending_run_tasks_workspace_identity_unique UNIQUE (workspace_id, id);


--
-- Name: preview_attempts preview_attempts_one_per_run; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.preview_attempts
    ADD CONSTRAINT preview_attempts_one_per_run UNIQUE (preview_run_id);


--
-- Name: preview_attempts preview_attempts_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.preview_attempts
    ADD CONSTRAINT preview_attempts_pkey PRIMARY KEY (id);


--
-- Name: preview_attempts preview_attempts_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.preview_attempts
    ADD CONSTRAINT preview_attempts_workspace_identity_unique UNIQUE (workspace_id, id);


--
-- Name: preview_runs preview_runs_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.preview_runs
    ADD CONSTRAINT preview_runs_pkey PRIMARY KEY (id);


--
-- Name: preview_runs preview_runs_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.preview_runs
    ADD CONSTRAINT preview_runs_workspace_identity_unique UNIQUE (workspace_id, id);


--
-- Name: preview_runs preview_runs_workspace_workflow_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.preview_runs
    ADD CONSTRAINT preview_runs_workspace_workflow_identity_unique UNIQUE (workspace_id, workflow_id, id);


--
-- Name: run_checkpoints run_checkpoints_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.run_checkpoints
    ADD CONSTRAINT run_checkpoints_pkey PRIMARY KEY (workflow_run_id);


--
-- Name: run_error_workflow_intents run_error_workflow_intents_workspace_id_source_run_id_pk; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.run_error_workflow_intents
    ADD CONSTRAINT run_error_workflow_intents_workspace_id_source_run_id_pk PRIMARY KEY (workspace_id, source_run_id);


--
-- Name: run_events run_events_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.run_events
    ADD CONSTRAINT run_events_pkey PRIMARY KEY (workflow_run_id, sequence);


--
-- Name: run_failure_notification_audit_facts run_failure_notification_audit_facts_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.run_failure_notification_audit_facts
    ADD CONSTRAINT run_failure_notification_audit_facts_pkey PRIMARY KEY (id);


--
-- Name: run_failure_notification_intents run_failure_notification_intents_logical_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.run_failure_notification_intents
    ADD CONSTRAINT run_failure_notification_intents_logical_unique UNIQUE (workflow_run_id, terminal_event_sequence);


--
-- Name: run_failure_notification_intents run_failure_notification_intents_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.run_failure_notification_intents
    ADD CONSTRAINT run_failure_notification_intents_pkey PRIMARY KEY (id);


--
-- Name: run_failure_notification_intents run_failure_notification_intents_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.run_failure_notification_intents
    ADD CONSTRAINT run_failure_notification_intents_workspace_identity_unique UNIQUE (workspace_id, id);


--
-- Name: system_mail_deliveries system_mail_deliveries_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.system_mail_deliveries
    ADD CONSTRAINT system_mail_deliveries_pkey PRIMARY KEY (id);


--
-- Name: transport_security_audit_facts transport_security_audit_facts_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.transport_security_audit_facts
    ADD CONSTRAINT transport_security_audit_facts_pkey PRIMARY KEY (id);


--
-- Name: trigger_coordinated_events trigger_coordinated_events_identity; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_coordinated_events
    ADD CONSTRAINT trigger_coordinated_events_identity UNIQUE (workspace_id, id);


--
-- Name: trigger_coordinated_events trigger_coordinated_events_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_coordinated_events
    ADD CONSTRAINT trigger_coordinated_events_pkey PRIMARY KEY (id);


--
-- Name: trigger_event_windows trigger_event_windows_identity; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_event_windows
    ADD CONSTRAINT trigger_event_windows_identity UNIQUE (workspace_id, id);


--
-- Name: trigger_event_windows trigger_event_windows_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_event_windows
    ADD CONSTRAINT trigger_event_windows_key UNIQUE (workspace_id, workflow_id, node_id, policy_hash, key_hash);


--
-- Name: trigger_event_windows trigger_event_windows_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_event_windows
    ADD CONSTRAINT trigger_event_windows_pkey PRIMARY KEY (id);


--
-- Name: trigger_schedule_occurrences trigger_schedule_occurrences_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_schedule_occurrences
    ADD CONSTRAINT trigger_schedule_occurrences_identity_unique UNIQUE (trigger_id, scheduled_at);


--
-- Name: trigger_schedule_occurrences trigger_schedule_occurrences_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_schedule_occurrences
    ADD CONSTRAINT trigger_schedule_occurrences_pkey PRIMARY KEY (id);


--
-- Name: trigger_schedule_occurrences trigger_schedule_occurrences_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_schedule_occurrences
    ADD CONSTRAINT trigger_schedule_occurrences_workspace_identity_unique UNIQUE (workspace_id, id);


--
-- Name: trigger_schedules trigger_schedules_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_schedules
    ADD CONSTRAINT trigger_schedules_pkey PRIMARY KEY (trigger_id);


--
-- Name: trigger_schedules trigger_schedules_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_schedules
    ADD CONSTRAINT trigger_schedules_workspace_identity_unique UNIQUE (workspace_id, trigger_id);


--
-- Name: usage_events usage_events_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.usage_events
    ADD CONSTRAINT usage_events_pkey PRIMARY KEY (id);


--
-- Name: usage_events usage_events_workspace_idempotency_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.usage_events
    ADD CONSTRAINT usage_events_workspace_idempotency_unique UNIQUE (workspace_id, idempotency_key);


--
-- Name: user_profile_command_receipts user_profile_command_receipts_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.user_profile_command_receipts
    ADD CONSTRAINT user_profile_command_receipts_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: webhook_endpoint_ingress_limits webhook_endpoint_ingress_limits_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_endpoint_ingress_limits
    ADD CONSTRAINT webhook_endpoint_ingress_limits_pkey PRIMARY KEY (endpoint_id);


--
-- Name: webhook_run_responses webhook_run_responses_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_run_responses
    ADD CONSTRAINT webhook_run_responses_pkey PRIMARY KEY (run_id);


--
-- Name: webhook_test_events webhook_test_events_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_test_events
    ADD CONSTRAINT webhook_test_events_key UNIQUE (endpoint_key_hash);


--
-- Name: webhook_test_events webhook_test_events_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_test_events
    ADD CONSTRAINT webhook_test_events_pkey PRIMARY KEY (id);


--
-- Name: webhook_test_events webhook_test_events_workflow; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_test_events
    ADD CONSTRAINT webhook_test_events_workflow UNIQUE (workspace_id, workflow_id);


--
-- Name: webhook_trigger_deliveries webhook_trigger_deliveries_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_deliveries
    ADD CONSTRAINT webhook_trigger_deliveries_pkey PRIMARY KEY (id);


--
-- Name: webhook_trigger_deliveries webhook_trigger_deliveries_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_deliveries
    ADD CONSTRAINT webhook_trigger_deliveries_workspace_identity_unique UNIQUE (workspace_id, id);


--
-- Name: webhook_trigger_endpoints webhook_trigger_endpoints_endpoint_key_hash_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_endpoints
    ADD CONSTRAINT webhook_trigger_endpoints_endpoint_key_hash_key UNIQUE (endpoint_key_hash);


--
-- Name: webhook_trigger_endpoints webhook_trigger_endpoints_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_endpoints
    ADD CONSTRAINT webhook_trigger_endpoints_pkey PRIMARY KEY (id);


--
-- Name: webhook_trigger_endpoints webhook_trigger_endpoints_step_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_endpoints
    ADD CONSTRAINT webhook_trigger_endpoints_step_unique UNIQUE (workspace_id, workflow_id, node_id);


--
-- Name: webhook_trigger_endpoints webhook_trigger_endpoints_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_endpoints
    ADD CONSTRAINT webhook_trigger_endpoints_workspace_identity_unique UNIQUE (workspace_id, id);


--
-- Name: webhook_trigger_replay_records webhook_trigger_replay_records_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_replay_records
    ADD CONSTRAINT webhook_trigger_replay_records_pkey PRIMARY KEY (endpoint_id, dedupe_key_hash);


--
-- Name: webhook_trigger_secret_versions webhook_trigger_secret_versions_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_secret_versions
    ADD CONSTRAINT webhook_trigger_secret_versions_pkey PRIMARY KEY (id);


--
-- Name: webhook_trigger_secret_versions webhook_trigger_secret_versions_step_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_secret_versions
    ADD CONSTRAINT webhook_trigger_secret_versions_step_identity_unique UNIQUE (workspace_id, workflow_id, node_id, id);


--
-- Name: workflow_calls workflow_calls_child_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_calls
    ADD CONSTRAINT workflow_calls_child_unique UNIQUE (workspace_id, child_run_id);


--
-- Name: workflow_calls workflow_calls_invocation_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_calls
    ADD CONSTRAINT workflow_calls_invocation_unique UNIQUE (workspace_id, parent_run_id, invocation_key);


--
-- Name: workflow_calls workflow_calls_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_calls
    ADD CONSTRAINT workflow_calls_pkey PRIMARY KEY (id);


--
-- Name: workflow_calls workflow_calls_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_calls
    ADD CONSTRAINT workflow_calls_workspace_identity_unique UNIQUE (workspace_id, id);


--
-- Name: workflow_comment_mentions workflow_comment_mentions_workspace_id_id_pk; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_comment_mentions
    ADD CONSTRAINT workflow_comment_mentions_workspace_id_id_pk PRIMARY KEY (workspace_id, id);


--
-- Name: workflow_comment_threads workflow_comment_threads_workspace_id_id_pk; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_comment_threads
    ADD CONSTRAINT workflow_comment_threads_workspace_id_id_pk PRIMARY KEY (workspace_id, id);


--
-- Name: workflow_comments workflow_comments_workspace_id_id_pk; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_comments
    ADD CONSTRAINT workflow_comments_workspace_id_id_pk PRIMARY KEY (workspace_id, id);


--
-- Name: workflow_concurrency_policies workflow_concurrency_policies_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_concurrency_policies
    ADD CONSTRAINT workflow_concurrency_policies_pkey PRIMARY KEY (workspace_id, workflow_id);


--
-- Name: workflow_drafts workflow_drafts_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_drafts
    ADD CONSTRAINT workflow_drafts_pkey PRIMARY KEY (workflow_id);


--
-- Name: workflow_error_policies workflow_error_policies_workspace_id_workflow_id_pk; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_error_policies
    ADD CONSTRAINT workflow_error_policies_workspace_id_workflow_id_pk PRIMARY KEY (workspace_id, workflow_id);


--
-- Name: workflow_failure_notification_policies workflow_failure_notification_policies_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_failure_notification_policies
    ADD CONSTRAINT workflow_failure_notification_policies_pkey PRIMARY KEY (workflow_id);


--
-- Name: workflow_failure_notification_policies workflow_failure_notification_policies_workspace_workflow_uniqu; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_failure_notification_policies
    ADD CONSTRAINT workflow_failure_notification_policies_workspace_workflow_uniqu UNIQUE (workspace_id, workflow_id);


--
-- Name: workflow_failure_streaks workflow_failure_streaks_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_failure_streaks
    ADD CONSTRAINT workflow_failure_streaks_pkey PRIMARY KEY (workspace_id, workflow_id);


--
-- Name: workflow_favorites workflow_favorites_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_favorites
    ADD CONSTRAINT workflow_favorites_pkey PRIMARY KEY (workspace_id, actor_id, workflow_id);


--
-- Name: workflow_folder_grants workflow_folder_grants_group_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_folder_grants
    ADD CONSTRAINT workflow_folder_grants_group_unique UNIQUE (workspace_id, folder_id, organization_id, group_id);


--
-- Name: workflow_folder_grants workflow_folder_grants_member_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_folder_grants
    ADD CONSTRAINT workflow_folder_grants_member_unique UNIQUE (workspace_id, folder_id, user_id);


--
-- Name: workflow_folder_grants workflow_folder_grants_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_folder_grants
    ADD CONSTRAINT workflow_folder_grants_pkey PRIMARY KEY (id);


--
-- Name: workflow_folders workflow_folders_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_folders
    ADD CONSTRAINT workflow_folders_pkey PRIMARY KEY (workspace_id, id);


--
-- Name: workflow_folders workflow_folders_workspace_id_parent_id_name_key_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_folders
    ADD CONSTRAINT workflow_folders_workspace_id_parent_id_name_key_key UNIQUE NULLS NOT DISTINCT (workspace_id, parent_id, name_key);


--
-- Name: workflow_forms workflow_forms_public_id_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_forms
    ADD CONSTRAINT workflow_forms_public_id_unique UNIQUE (public_id);


--
-- Name: workflow_forms workflow_forms_workspace_id_workflow_id_pk; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_forms
    ADD CONSTRAINT workflow_forms_workspace_id_workflow_id_pk PRIMARY KEY (workspace_id, workflow_id);


--
-- Name: workflow_input_case_payloads workflow_input_case_payloads_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_input_case_payloads
    ADD CONSTRAINT workflow_input_case_payloads_pkey PRIMARY KEY (workspace_id, case_id, revision);


--
-- Name: workflow_input_cases workflow_input_cases_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_input_cases
    ADD CONSTRAINT workflow_input_cases_pkey PRIMARY KEY (id);


--
-- Name: workflow_input_cases workflow_input_cases_workspace_id_id_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_input_cases
    ADD CONSTRAINT workflow_input_cases_workspace_id_id_key UNIQUE (workspace_id, id);


--
-- Name: workflow_integration_usage workflow_integration_usage_identity_pk; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_integration_usage
    ADD CONSTRAINT workflow_integration_usage_identity_pk PRIMARY KEY (workflow_version_id, provider_key, operation_key, connection_id);


--
-- Name: workflow_manual_start_rejections workflow_manual_start_rejections_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_manual_start_rejections
    ADD CONSTRAINT workflow_manual_start_rejections_pkey PRIMARY KEY (workspace_id, scope, key_hash);


--
-- Name: workflow_organization_state workflow_organization_state_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_organization_state
    ADD CONSTRAINT workflow_organization_state_pkey PRIMARY KEY (workspace_id, workflow_id);


--
-- Name: workflow_presence_leases workflow_presence_leases_workspace_id_workflow_id_user_id_tab_i; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_presence_leases
    ADD CONSTRAINT workflow_presence_leases_workspace_id_workflow_id_user_id_tab_i PRIMARY KEY (workspace_id, workflow_id, user_id, tab_id);


--
-- Name: workflow_promotion_origins workflow_promotion_origins_workspace_id_workflow_id_pk; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_promotion_origins
    ADD CONSTRAINT workflow_promotion_origins_workspace_id_workflow_id_pk PRIMARY KEY (workspace_id, workflow_id);


--
-- Name: workflow_publication_requests workflow_publication_requests_workspace_id_id_pk; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_publication_requests
    ADD CONSTRAINT workflow_publication_requests_workspace_id_id_pk PRIMARY KEY (workspace_id, id);


--
-- Name: workflow_run_active_admissions workflow_run_active_admissions_call_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_run_active_admissions
    ADD CONSTRAINT workflow_run_active_admissions_call_unique UNIQUE (borrowed_call_id);


--
-- Name: workflow_run_active_admissions workflow_run_active_admissions_outbox_event_id_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_run_active_admissions
    ADD CONSTRAINT workflow_run_active_admissions_outbox_event_id_key UNIQUE (outbox_event_id);


--
-- Name: workflow_run_active_admissions workflow_run_active_admissions_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_run_active_admissions
    ADD CONSTRAINT workflow_run_active_admissions_pkey PRIMARY KEY (workflow_run_id);


--
-- Name: workflow_run_values workflow_run_values_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_run_values
    ADD CONSTRAINT workflow_run_values_pkey PRIMARY KEY (id);


--
-- Name: workflow_run_values workflow_run_values_preview_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_run_values
    ADD CONSTRAINT workflow_run_values_preview_key UNIQUE (workspace_id, preview_run_id, key);


--
-- Name: workflow_run_values workflow_run_values_run_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_run_values
    ADD CONSTRAINT workflow_run_values_run_key UNIQUE (workspace_id, workflow_run_id, key);


--
-- Name: workflow_runs workflow_runs_failure_notification_pin_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_failure_notification_pin_unique UNIQUE (workspace_id, id, failure_notification_destination_id, failure_notification_destination_config_version, failure_notification_side_effect_class, failure_notification_connection_secret_version_id);


--
-- Name: workflow_runs workflow_runs_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_pkey PRIMARY KEY (id);


--
-- Name: workflow_runs workflow_runs_replay_command_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_replay_command_unique UNIQUE (replay_command_id);


--
-- Name: workflow_runs workflow_runs_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_workspace_identity_unique UNIQUE (workspace_id, id);


--
-- Name: workflow_runs workflow_runs_workspace_version_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_workspace_version_identity_unique UNIQUE (workspace_id, id, workflow_version_id);


--
-- Name: workflow_step_samples workflow_step_samples_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_step_samples
    ADD CONSTRAINT workflow_step_samples_pkey PRIMARY KEY (id);


--
-- Name: workflow_step_samples workflow_step_samples_step_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_step_samples
    ADD CONSTRAINT workflow_step_samples_step_key UNIQUE (workspace_id, workflow_id, node_id);


--
-- Name: workflow_step_samples workflow_step_samples_workspace_id_id_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_step_samples
    ADD CONSTRAINT workflow_step_samples_workspace_id_id_key UNIQUE (workspace_id, id);


--
-- Name: workflow_tag_assignments workflow_tag_assignments_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_tag_assignments
    ADD CONSTRAINT workflow_tag_assignments_pkey PRIMARY KEY (workspace_id, workflow_id, tag_id);


--
-- Name: workflow_tags workflow_tags_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_tags
    ADD CONSTRAINT workflow_tags_pkey PRIMARY KEY (workspace_id, id);


--
-- Name: workflow_tags workflow_tags_workspace_id_key_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_tags
    ADD CONSTRAINT workflow_tags_workspace_id_key_key UNIQUE (workspace_id, key);


--
-- Name: workflow_template_origins workflow_template_origins_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_template_origins
    ADD CONSTRAINT workflow_template_origins_pkey PRIMARY KEY (workspace_id, workflow_id);


--
-- Name: workflow_test_snapshots workflow_test_snapshots_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_test_snapshots
    ADD CONSTRAINT workflow_test_snapshots_pkey PRIMARY KEY (id);


--
-- Name: workflow_test_snapshots workflow_test_snapshots_workspace_id_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_test_snapshots
    ADD CONSTRAINT workflow_test_snapshots_workspace_id_key UNIQUE (workspace_id, id);


--
-- Name: workflow_test_suite_cases workflow_test_suite_cases_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_test_suite_cases
    ADD CONSTRAINT workflow_test_suite_cases_pkey PRIMARY KEY (workspace_id, suite_id, ordinal);


--
-- Name: workflow_test_suites workflow_test_suites_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_test_suites
    ADD CONSTRAINT workflow_test_suites_pkey PRIMARY KEY (id);


--
-- Name: workflow_test_suites workflow_test_suites_workspace_id_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_test_suites
    ADD CONSTRAINT workflow_test_suites_workspace_id_key UNIQUE (workspace_id, id);


--
-- Name: workflow_trigger_failures workflow_trigger_failures_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_trigger_failures
    ADD CONSTRAINT workflow_trigger_failures_pkey PRIMARY KEY (id);


--
-- Name: workflow_trigger_outcomes workflow_trigger_outcomes_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_trigger_outcomes
    ADD CONSTRAINT workflow_trigger_outcomes_pkey PRIMARY KEY (id);


--
-- Name: workflow_trigger_pause_periods workflow_trigger_pause_periods_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_trigger_pause_periods
    ADD CONSTRAINT workflow_trigger_pause_periods_pkey PRIMARY KEY (workspace_id, workflow_id, pause_revision);


--
-- Name: workflow_triggers workflow_triggers_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_triggers
    ADD CONSTRAINT workflow_triggers_pkey PRIMARY KEY (id);


--
-- Name: workflow_triggers workflow_triggers_step_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_triggers
    ADD CONSTRAINT workflow_triggers_step_identity_unique UNIQUE (workspace_id, id, workflow_id, node_id);


--
-- Name: workflow_triggers workflow_triggers_version_node_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_triggers
    ADD CONSTRAINT workflow_triggers_version_node_unique UNIQUE (workflow_version_id, node_id);


--
-- Name: workflow_triggers workflow_triggers_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_triggers
    ADD CONSTRAINT workflow_triggers_workspace_identity_unique UNIQUE (workspace_id, id);


--
-- Name: workflow_version_dependencies workflow_version_dependencies_workspace_id_parent_version_id_no; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_version_dependencies
    ADD CONSTRAINT workflow_version_dependencies_workspace_id_parent_version_id_no PRIMARY KEY (workspace_id, parent_version_id, node_id);


--
-- Name: workflow_version_promotions workflow_version_promotions_pk; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_version_promotions
    ADD CONSTRAINT workflow_version_promotions_pk PRIMARY KEY (workspace_id, version_id, source_workspace_id, source_workflow_id, source_version_id);


--
-- Name: workflow_versions workflow_versions_number_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_versions
    ADD CONSTRAINT workflow_versions_number_unique UNIQUE (workflow_id, version_number);


--
-- Name: workflow_versions workflow_versions_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_versions
    ADD CONSTRAINT workflow_versions_pkey PRIMARY KEY (id);


--
-- Name: workflow_versions workflow_versions_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_versions
    ADD CONSTRAINT workflow_versions_workspace_identity_unique UNIQUE (workspace_id, workflow_id, id);


--
-- Name: workflow_versions workflow_versions_workspace_version_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_versions
    ADD CONSTRAINT workflow_versions_workspace_version_identity_unique UNIQUE (workspace_id, id);


--
-- Name: workflows workflows_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflows
    ADD CONSTRAINT workflows_pkey PRIMARY KEY (id);


--
-- Name: workflows workflows_workspace_identity_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflows
    ADD CONSTRAINT workflows_workspace_identity_unique UNIQUE (workspace_id, id);


--
-- Name: workspace_artifact_capacity workspace_artifact_capacity_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_artifact_capacity
    ADD CONSTRAINT workspace_artifact_capacity_pkey PRIMARY KEY (workspace_id);


--
-- Name: workspace_creation_idempotency_records workspace_creation_idempotency_active_key_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_creation_idempotency_records
    ADD CONSTRAINT workspace_creation_idempotency_active_key_unique UNIQUE (actor_user_id, operation, key_hash);


--
-- Name: workspace_creation_idempotency_records workspace_creation_idempotency_records_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_creation_idempotency_records
    ADD CONSTRAINT workspace_creation_idempotency_records_pkey PRIMARY KEY (id);


--
-- Name: workspace_data_table_quotas workspace_data_table_quotas_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_data_table_quotas
    ADD CONSTRAINT workspace_data_table_quotas_pkey PRIMARY KEY (workspace_id);


--
-- Name: workspace_data_table_rows workspace_data_table_rows_key; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_data_table_rows
    ADD CONSTRAINT workspace_data_table_rows_key UNIQUE (workspace_id, table_id, key_value);


--
-- Name: workspace_data_table_rows workspace_data_table_rows_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_data_table_rows
    ADD CONSTRAINT workspace_data_table_rows_pkey PRIMARY KEY (id);


--
-- Name: workspace_data_tables workspace_data_tables_identity; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_data_tables
    ADD CONSTRAINT workspace_data_tables_identity UNIQUE (workspace_id, id);


--
-- Name: workspace_data_tables workspace_data_tables_name; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_data_tables
    ADD CONSTRAINT workspace_data_tables_name UNIQUE (workspace_id, name);


--
-- Name: workspace_data_tables workspace_data_tables_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_data_tables
    ADD CONSTRAINT workspace_data_tables_pkey PRIMARY KEY (id);


--
-- Name: workspace_execution_admission_counters workspace_execution_admission_counters_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_execution_admission_counters
    ADD CONSTRAINT workspace_execution_admission_counters_pkey PRIMARY KEY (workspace_id);


--
-- Name: workspace_execution_entitlement_versions workspace_execution_entitlement_versions_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_execution_entitlement_versions
    ADD CONSTRAINT workspace_execution_entitlement_versions_pkey PRIMARY KEY (workspace_id, version);


--
-- Name: workspace_execution_entitlements workspace_execution_entitlements_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_execution_entitlements
    ADD CONSTRAINT workspace_execution_entitlements_pkey PRIMARY KEY (workspace_id);


--
-- Name: workspace_inbox_events workspace_inbox_events_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_inbox_events
    ADD CONSTRAINT workspace_inbox_events_pkey PRIMARY KEY (id);


--
-- Name: workspace_inbox_failure_days workspace_inbox_failure_days_workspace_id_workflow_id_day_pk; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_inbox_failure_days
    ADD CONSTRAINT workspace_inbox_failure_days_workspace_id_workflow_id_day_pk PRIMARY KEY (workspace_id, workflow_id, day);


--
-- Name: workspace_inbox_reads workspace_inbox_reads_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_inbox_reads
    ADD CONSTRAINT workspace_inbox_reads_pkey PRIMARY KEY (workspace_id, user_id, thread_id);


--
-- Name: workspace_inbox_threads workspace_inbox_threads_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_inbox_threads
    ADD CONSTRAINT workspace_inbox_threads_pkey PRIMARY KEY (workspace_id, id);


--
-- Name: workspace_invitation_acceptance_intents workspace_invitation_acceptance_intents_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_invitation_acceptance_intents
    ADD CONSTRAINT workspace_invitation_acceptance_intents_pkey PRIMARY KEY (id);


--
-- Name: workspace_invitation_binding_replacement_claims workspace_invitation_binding_replacement_claims_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_invitation_binding_replacement_claims
    ADD CONSTRAINT workspace_invitation_binding_replacement_claims_pkey PRIMARY KEY (prior_workspace_id, prior_intent_id, prior_binding_digest);


--
-- Name: workspace_invitation_delivery_attempts workspace_invitation_delivery_attempts_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_invitation_delivery_attempts
    ADD CONSTRAINT workspace_invitation_delivery_attempts_pkey PRIMARY KEY (id);


--
-- Name: workspace_invitations workspace_invitations_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_invitations
    ADD CONSTRAINT workspace_invitations_pkey PRIMARY KEY (id);


--
-- Name: workspace_lifecycle_operations workspace_lifecycle_operations_idempotency_unique; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_lifecycle_operations
    ADD CONSTRAINT workspace_lifecycle_operations_idempotency_unique UNIQUE (workspace_id, idempotency_key_hash);


--
-- Name: workspace_lifecycle_operations workspace_lifecycle_operations_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_lifecycle_operations
    ADD CONSTRAINT workspace_lifecycle_operations_pkey PRIMARY KEY (id);


--
-- Name: workspace_memberships workspace_memberships_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_memberships
    ADD CONSTRAINT workspace_memberships_pkey PRIMARY KEY (workspace_id, user_id);


--
-- Name: workspace_promotion_targets workspace_promotion_targets_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_promotion_targets
    ADD CONSTRAINT workspace_promotion_targets_pkey PRIMARY KEY (workspace_id);


--
-- Name: workspace_variable_set_revisions workspace_variable_set_revisions_workspace_id_revision_pk; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_variable_set_revisions
    ADD CONSTRAINT workspace_variable_set_revisions_workspace_id_revision_pk PRIMARY KEY (workspace_id, revision);


--
-- Name: workspace_variables workspace_variables_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_variables
    ADD CONSTRAINT workspace_variables_pkey PRIMARY KEY (workspace_id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: pertexo_internal; Owner: pertexo_owner
--

ALTER TABLE ONLY pertexo_internal.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (name);


--
-- Name: api_tokens_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX api_tokens_expiry_idx ON app.api_tokens USING btree (expires_at, id);


--
-- Name: api_tokens_owner_page_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX api_tokens_owner_page_idx ON app.api_tokens USING btree (workspace_id, owner_user_id, id);


--
-- Name: api_tokens_revoked_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX api_tokens_revoked_idx ON app.api_tokens USING btree (revoked_at, id) WHERE (revoked_at IS NOT NULL);


--
-- Name: artifact_links_owner_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX artifact_links_owner_idx ON app.artifact_links USING btree (workspace_id, owner_kind, owner_id, artifact_id);


--
-- Name: artifact_owner_references_owner_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX artifact_owner_references_owner_idx ON app.artifact_owner_references USING btree (workspace_id, owner_family, owner_id, owner_sub_id);


--
-- Name: artifacts_available_retention_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX artifacts_available_retention_idx ON app.artifacts USING btree (expires_at, retention_retry_at, id) WHERE ((status)::text = 'available'::text);


--
-- Name: artifacts_pending_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX artifacts_pending_expiry_idx ON app.artifacts USING btree (workspace_id, expires_at, id) WHERE ((status)::text = 'pending'::text);


--
-- Name: artifacts_storage_key_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX artifacts_storage_key_idx ON app.artifacts USING btree (storage_key);


--
-- Name: artifacts_workspace_status_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX artifacts_workspace_status_idx ON app.artifacts USING btree (workspace_id, status, id);


--
-- Name: audit_events_workspace_target_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX audit_events_workspace_target_idx ON app.audit_events USING btree (workspace_id, target_type, target_id, occurred_at DESC);


--
-- Name: audit_events_workspace_time_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX audit_events_workspace_time_idx ON app.audit_events USING btree (workspace_id, occurred_at DESC, id);


--
-- Name: auth_accounts_user_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_accounts_user_idx ON app.auth_accounts USING btree (user_id, id);


--
-- Name: auth_directory_group_external_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX auth_directory_group_external_unique ON app.auth_directory_groups USING btree (organization_id, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: auth_directory_group_member_user_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_directory_group_member_user_idx ON app.auth_directory_group_members USING btree (organization_id, directory_user_id, group_id);


--
-- Name: auth_directory_membership_user_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_directory_membership_user_idx ON app.auth_directory_memberships USING btree (organization_id, directory_user_id);


--
-- Name: auth_directory_user_bound_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_directory_user_bound_idx ON app.auth_directory_users USING btree (user_id, organization_id);


--
-- Name: auth_directory_user_email_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_directory_user_email_idx ON app.auth_directory_users USING btree (organization_id, login_email);


--
-- Name: auth_directory_user_live_binding_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX auth_directory_user_live_binding_unique ON app.auth_directory_users USING btree (organization_id, user_id) WHERE ((deleted_at IS NULL) AND (user_id IS NOT NULL));


--
-- Name: auth_directory_user_live_email_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX auth_directory_user_live_email_unique ON app.auth_directory_users USING btree (organization_id, login_email) WHERE (deleted_at IS NULL);


--
-- Name: auth_directory_user_live_external_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX auth_directory_user_live_external_unique ON app.auth_directory_users USING btree (organization_id, external_id) WHERE ((deleted_at IS NULL) AND (external_id IS NOT NULL));


--
-- Name: auth_directory_user_live_name_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX auth_directory_user_live_name_unique ON app.auth_directory_users USING btree (organization_id, normalized_user_name) WHERE (deleted_at IS NULL);


--
-- Name: auth_domain_claim_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX auth_domain_claim_unique ON app.auth_domains USING btree (domain) WHERE (verified_at IS NOT NULL);


--
-- Name: auth_email_proofs_retention_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_email_proofs_retention_idx ON app.auth_email_proofs USING btree (expires_at, id);


--
-- Name: auth_email_proofs_user_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_email_proofs_user_idx ON app.auth_email_proofs USING btree (user_id, purpose, created_at);


--
-- Name: auth_federation_attempt_domain_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_federation_attempt_domain_idx ON app.auth_federation_attempts USING btree (organization_id, domain_id);


--
-- Name: auth_federation_attempt_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_federation_attempt_expiry_idx ON app.auth_federation_attempts USING btree (expires_at, id);


--
-- Name: auth_federation_attempt_provider_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_federation_attempt_provider_idx ON app.auth_federation_attempts USING btree (organization_id, provider_id);


--
-- Name: auth_method_link_attempts_retention_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_method_link_attempts_retention_idx ON app.auth_method_link_attempts USING btree (expires_at, id);


--
-- Name: auth_method_link_attempts_user_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_method_link_attempts_user_idx ON app.auth_method_link_attempts USING btree (user_id, session_id, created_at);


--
-- Name: auth_provider_checks_provider_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_provider_checks_provider_idx ON app.auth_provider_checks USING btree (organization_id, provider_id);


--
-- Name: auth_provisioning_credential_org_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_provisioning_credential_org_idx ON app.auth_provisioning_credentials USING btree (organization_id, id);


--
-- Name: auth_sessions_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_sessions_expiry_idx ON app.auth_sessions USING btree (expires_at, id);


--
-- Name: auth_sessions_federation_provider_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_sessions_federation_provider_idx ON app.auth_sessions USING btree (federation_provider_id, id);


--
-- Name: auth_sessions_user_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_sessions_user_expiry_idx ON app.auth_sessions USING btree (user_id, expires_at, id);


--
-- Name: auth_sign_in_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_sign_in_expiry_idx ON app.auth_sign_in_attempts USING btree (expires_at, id);


--
-- Name: auth_verifications_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_verifications_expiry_idx ON app.auth_verifications USING btree (expires_at, id);


--
-- Name: auth_verifications_identifier_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX auth_verifications_identifier_idx ON app.auth_verifications USING btree (identifier, id);


--
-- Name: comment_mention_person_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX comment_mention_person_unique ON app.workflow_comment_mentions USING btree (workspace_id, comment_id, user_id);


--
-- Name: comment_mentions_recent_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX comment_mentions_recent_idx ON app.workflow_comment_mentions USING btree (created_at, id);


--
-- Name: comment_threads_workflow_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX comment_threads_workflow_idx ON app.workflow_comment_threads USING btree (workspace_id, workflow_id, id);


--
-- Name: comments_thread_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX comments_thread_idx ON app.workflow_comments USING btree (workspace_id, thread_id, id);


--
-- Name: connection_events_connection_time_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX connection_events_connection_time_idx ON app.connection_events USING btree (workspace_id, connection_id, created_at DESC, id);


--
-- Name: connection_events_time_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX connection_events_time_idx ON app.connection_events USING btree (created_at, id);


--
-- Name: connection_events_workspace_time_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX connection_events_workspace_time_idx ON app.connection_events USING btree (workspace_id, created_at DESC, id);


--
-- Name: connection_health_observations_workspace_time_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX connection_health_observations_workspace_time_idx ON app.connection_health_observations USING btree (workspace_id, observed_at, id);


--
-- Name: connection_secret_versions_connection_created_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX connection_secret_versions_connection_created_idx ON app.connection_secret_versions USING btree (workspace_id, connection_id, created_at DESC, id);


--
-- Name: connection_shares_member_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX connection_shares_member_idx ON app.connection_shares USING btree (workspace_id, user_id, connection_id);


--
-- Name: connections_active_name_provider_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX connections_active_name_provider_unique ON app.connections USING btree (workspace_id, provider_key, lower((name)::text)) WHERE ((status)::text <> 'revoked'::text);


--
-- Name: connections_workspace_status_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX connections_workspace_status_idx ON app.connections USING btree (workspace_id, status, created_at DESC, id);


--
-- Name: data_table_receipts_preview_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX data_table_receipts_preview_idx ON app.data_table_write_receipts USING btree (workspace_id, preview_run_id) WHERE (preview_run_id IS NOT NULL);


--
-- Name: data_table_receipts_run_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX data_table_receipts_run_idx ON app.data_table_write_receipts USING btree (workspace_id, run_id) WHERE (run_id IS NOT NULL);


--
-- Name: failure_notification_destinations_workspace_status_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX failure_notification_destinations_workspace_status_idx ON app.failure_notification_destinations USING btree (workspace_id, status, created_at, id);


--
-- Name: form_uploads_session_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX form_uploads_session_idx ON app.form_uploads USING btree (workspace_id, session_hash);


--
-- Name: form_uploads_unsent_public_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX form_uploads_unsent_public_idx ON app.form_uploads USING btree (workspace_id) WHERE ((capability_hash IS NOT NULL) AND (submitted_at IS NULL));


--
-- Name: idempotency_records_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX idempotency_records_expiry_idx ON app.idempotency_records USING btree (expires_at, id) WHERE (expires_at IS NOT NULL);


--
-- Name: idempotency_records_resource_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX idempotency_records_resource_idx ON app.idempotency_records USING btree (workspace_id, resource_id);


--
-- Name: identity_security_audit_retention_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX identity_security_audit_retention_idx ON app.identity_security_audit_facts USING btree (occurred_at, id);


--
-- Name: identity_security_audit_user_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX identity_security_audit_user_idx ON app.identity_security_audit_facts USING btree (user_id, occurred_at);


--
-- Name: inbox_receipts_retention_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX inbox_receipts_retention_idx ON app.inbox_receipts USING btree (received_at, message_id);


--
-- Name: inbox_receipts_workspace_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX inbox_receipts_workspace_idx ON app.inbox_receipts USING btree (workspace_id, received_at DESC);


--
-- Name: node_attempts_expired_lease_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX node_attempts_expired_lease_idx ON app.node_attempts USING btree (lease_expires_at, id) WHERE (((status)::text = 'running'::text) AND (lease_expires_at IS NOT NULL));


--
-- Name: node_attempts_node_status_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX node_attempts_node_status_idx ON app.node_attempts USING btree (workspace_id, node_run_id, status, attempt_number);


--
-- Name: node_attempts_one_nonterminal_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX node_attempts_one_nonterminal_idx ON app.node_attempts USING btree (node_run_id) WHERE ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('ready'::character varying)::text, ('running'::character varying)::text, ('waiting'::character varying)::text]));


--
-- Name: node_runs_current_attempt_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX node_runs_current_attempt_idx ON app.node_runs USING btree (workspace_id, current_attempt_id) WHERE (current_attempt_id IS NOT NULL);


--
-- Name: node_runs_due_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX node_runs_due_idx ON app.node_runs USING btree (workspace_id, retry_due_at, resume_at, id) WHERE ((status)::text = 'waiting'::text);


--
-- Name: node_runs_due_wakeup_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX node_runs_due_wakeup_idx ON app.node_runs USING btree (COALESCE(retry_due_at, resume_at), id) WHERE (((status)::text = 'waiting'::text) AND (COALESCE(retry_due_at, resume_at) IS NOT NULL));


--
-- Name: node_runs_operator_due_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX node_runs_operator_due_idx ON app.node_runs USING btree (workspace_id, workflow_run_id, COALESCE(retry_due_at, resume_at), id) WHERE ((status)::text = 'waiting'::text);


--
-- Name: node_runs_run_node_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX node_runs_run_node_idx ON app.node_runs USING btree (workspace_id, workflow_run_id, node_id, id);


--
-- Name: node_runs_run_status_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX node_runs_run_status_idx ON app.node_runs USING btree (workspace_id, workflow_run_id, status, id);


--
-- Name: notice_mail_batches_person_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX notice_mail_batches_person_idx ON app.notice_mail_batches USING btree (workspace_id, user_id, created_at);


--
-- Name: notice_mail_batches_window_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX notice_mail_batches_window_unique ON app.notice_mail_batches USING btree (workspace_id, user_id, window_key) WHERE (released_at IS NULL);


--
-- Name: notice_mail_batches_workspace_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX notice_mail_batches_workspace_unique ON app.notice_mail_batches USING btree (workspace_id, id);


--
-- Name: notice_mail_items_coverage_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX notice_mail_items_coverage_idx ON app.notice_mail_items USING btree (workspace_id, thread_id, revision);


--
-- Name: operator_commands_workspace_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX operator_commands_workspace_idx ON app.operator_commands USING btree (workspace_id);


--
-- Name: outbox_events_delivery_due_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX outbox_events_delivery_due_idx ON app.outbox_events USING btree (delivery_due_at, id) WHERE (delivery_due_at IS NOT NULL);


--
-- Name: outbox_events_dispatch_job_due_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX outbox_events_dispatch_job_due_idx ON app.outbox_events USING btree (job_name, available_at, id) WHERE ((published_at IS NULL) AND (failed_at IS NULL));


--
-- Name: outbox_events_due_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX outbox_events_due_idx ON app.outbox_events USING btree (available_at, id) WHERE ((published_at IS NULL) AND (failed_at IS NULL));


--
-- Name: outbox_events_error_workflow_repair_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX outbox_events_error_workflow_repair_idx ON app.outbox_events USING btree (delivery_due_at, id) WHERE (((job_name)::text = 'start-error-workflow'::text) AND (failed_at IS NOT NULL) AND (delivery_due_at IS NOT NULL));


--
-- Name: outbox_events_expired_lease_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX outbox_events_expired_lease_idx ON app.outbox_events USING btree (lease_expires_at, id) WHERE ((lease_expires_at IS NOT NULL) AND (published_at IS NULL) AND (failed_at IS NULL));


--
-- Name: outbox_events_failed_page_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX outbox_events_failed_page_idx ON app.outbox_events USING btree (failed_at, id) WHERE (failed_at IS NOT NULL);


--
-- Name: outbox_events_failed_retention_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX outbox_events_failed_retention_idx ON app.outbox_events USING btree (failed_at, id) WHERE ((failed_at IS NOT NULL) AND (delivery_due_at IS NULL));


--
-- Name: outbox_events_published_retention_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX outbox_events_published_retention_idx ON app.outbox_events USING btree (published_at, id) WHERE ((published_at IS NOT NULL) AND (failed_at IS NULL) AND (delivery_due_at IS NULL));


--
-- Name: outbox_events_run_delivery_page_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX outbox_events_run_delivery_page_idx ON app.outbox_events USING btree (delivery_due_at, id) WHERE (((job_name)::text = ANY ((ARRAY['advance-workflow-run'::character varying, 'execute-node-attempt'::character varying])::text[])) AND (delivery_due_at IS NOT NULL));


--
-- Name: outbox_events_run_publication_page_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX outbox_events_run_publication_page_idx ON app.outbox_events USING btree (available_at, id) WHERE (((job_name)::text = ANY ((ARRAY['advance-workflow-run'::character varying, 'execute-node-attempt'::character varying])::text[])) AND (published_at IS NULL) AND (failed_at IS NULL));


--
-- Name: outbox_events_workspace_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX outbox_events_workspace_idx ON app.outbox_events USING btree (workspace_id, id);


--
-- Name: pending_run_tasks_callback_inventory_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX pending_run_tasks_callback_inventory_idx ON app.pending_run_tasks USING btree (callback_key_version COLLATE "C", id) WHERE (((kind)::text = 'callback'::text) AND (consumed_at IS NULL) AND ((status)::text = ANY ((ARRAY['prepared'::character varying, 'pending'::character varying, 'submitted'::character varying])::text[])));


--
-- Name: pending_run_tasks_node_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX pending_run_tasks_node_idx ON app.pending_run_tasks USING btree (workspace_id, node_run_id);


--
-- Name: pending_run_tasks_unconsumed_run_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX pending_run_tasks_unconsumed_run_idx ON app.pending_run_tasks USING btree (workspace_id, run_id) WHERE (consumed_at IS NULL);


--
-- Name: pending_run_tasks_workspace_status_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX pending_run_tasks_workspace_status_idx ON app.pending_run_tasks USING btree (workspace_id, status, id);


--
-- Name: presence_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX presence_expiry_idx ON app.workflow_presence_leases USING btree (expires_at);


--
-- Name: preview_attempts_claim_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX preview_attempts_claim_idx ON app.preview_attempts USING btree (status, lease_expires_at, id) WHERE ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text]));


--
-- Name: preview_runs_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX preview_runs_expiry_idx ON app.preview_runs USING btree (expires_at, id);


--
-- Name: preview_runs_unfinished_deadline_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX preview_runs_unfinished_deadline_idx ON app.preview_runs USING btree (execution_deadline_at, id) WHERE ((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying])::text[]));


--
-- Name: preview_runs_variable_set_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX preview_runs_variable_set_idx ON app.preview_runs USING btree (workspace_id, variable_set_revision) WHERE (variable_set_revision IS NOT NULL);


--
-- Name: preview_runs_workflow_created_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX preview_runs_workflow_created_idx ON app.preview_runs USING btree (workspace_id, workflow_id, created_at DESC, id);


--
-- Name: preview_runs_workspace_created_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX preview_runs_workspace_created_idx ON app.preview_runs USING btree (workspace_id, created_at DESC, id);


--
-- Name: promotion_origin_source_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX promotion_origin_source_unique ON app.workflow_promotion_origins USING btree (workspace_id, source_workspace_id, source_workflow_id);


--
-- Name: publication_requests_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX publication_requests_expiry_idx ON app.workflow_publication_requests USING btree (expires_at, id);


--
-- Name: publication_requests_pending_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX publication_requests_pending_unique ON app.workflow_publication_requests USING btree (workspace_id, workflow_id) WHERE ((status)::text = 'pending'::text);


--
-- Name: publication_requests_recent_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX publication_requests_recent_idx ON app.workflow_publication_requests USING btree (workspace_id, workflow_id, created_at, id);


--
-- Name: run_checkpoints_due_resume_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX run_checkpoints_due_resume_idx ON app.run_checkpoints USING btree (resume_at, workflow_run_id) WHERE (resume_at IS NOT NULL);


--
-- Name: run_error_workflow_intents_target_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX run_error_workflow_intents_target_idx ON app.run_error_workflow_intents USING btree (workspace_id, target_version_id);


--
-- Name: run_events_workspace_created_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX run_events_workspace_created_idx ON app.run_events USING btree (workspace_id, created_at DESC, workflow_run_id, sequence);


--
-- Name: run_failure_notification_audit_workspace_intent_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX run_failure_notification_audit_workspace_intent_idx ON app.run_failure_notification_audit_facts USING btree (workspace_id, notification_intent_id, occurred_at, id);


--
-- Name: run_failure_notification_intents_destination_completed_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX run_failure_notification_intents_destination_completed_idx ON app.run_failure_notification_intents USING btree (workspace_id, destination_id, completed_at, id) WHERE (completed_at IS NOT NULL);


--
-- Name: run_failure_notification_intents_recovery_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX run_failure_notification_intents_recovery_idx ON app.run_failure_notification_intents USING btree (recovery_at, id) WHERE ((status)::text = ANY (ARRAY[('claimed'::character varying)::text, ('dispatching'::character varying)::text]));


--
-- Name: run_failure_notification_intents_retry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX run_failure_notification_intents_retry_idx ON app.run_failure_notification_intents USING btree (next_delivery_at, id) WHERE ((status)::text = 'retry'::text);


--
-- Name: run_failure_notification_intents_workspace_run_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX run_failure_notification_intents_workspace_run_idx ON app.run_failure_notification_intents USING btree (workspace_id, workflow_run_id, id);


--
-- Name: schedule_occurrences_retention_dry_run_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX schedule_occurrences_retention_dry_run_idx ON app.trigger_schedule_occurrences USING btree (workspace_id, scheduled_at, id);


--
-- Name: schedule_occurrences_run_retention_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX schedule_occurrences_run_retention_idx ON app.trigger_schedule_occurrences USING btree (workspace_id, workflow_run_id) WHERE (workflow_run_id IS NOT NULL);


--
-- Name: system_mail_due_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX system_mail_due_idx ON app.system_mail_deliveries USING btree (next_attempt_at, id) WHERE ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('outcome_unknown'::character varying)::text, ('retry'::character varying)::text]));


--
-- Name: system_mail_retention_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX system_mail_retention_idx ON app.system_mail_deliveries USING btree (completed_at, id) WHERE ((status)::text = ANY (ARRAY[('submitted'::character varying)::text, ('failed'::character varying)::text, ('reconciliation_required'::character varying)::text, ('expired'::character varying)::text]));


--
-- Name: transport_audit_retention_dry_run_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX transport_audit_retention_dry_run_idx ON app.transport_security_audit_facts USING btree (workspace_id, occurred_at, id);


--
-- Name: transport_security_audit_facts_message_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX transport_security_audit_facts_message_idx ON app.transport_security_audit_facts USING btree (workspace_id, message_id);


--
-- Name: trigger_coordinated_events_budget; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX trigger_coordinated_events_budget ON app.trigger_coordinated_events USING btree (workspace_id) WHERE ((status)::text = 'pending'::text);


--
-- Name: trigger_coordinated_events_debounce; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX trigger_coordinated_events_debounce ON app.trigger_coordinated_events USING btree (key_id) WHERE (((status)::text = 'pending'::text) AND ((mode)::text = 'debounce'::text));


--
-- Name: trigger_coordinated_events_due; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX trigger_coordinated_events_due ON app.trigger_coordinated_events USING btree (due_at, id) WHERE ((status)::text = 'pending'::text);


--
-- Name: trigger_coordinated_events_expiry; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX trigger_coordinated_events_expiry ON app.trigger_coordinated_events USING btree (expires_at, id);


--
-- Name: trigger_coordinated_events_head; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX trigger_coordinated_events_head ON app.trigger_coordinated_events USING btree (key_id, received_at, id) WHERE ((status)::text = 'pending'::text);


--
-- Name: trigger_coordinated_events_history; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX trigger_coordinated_events_history ON app.trigger_coordinated_events USING btree (workspace_id, workflow_id, node_id, received_at, id);


--
-- Name: trigger_coordinated_events_run; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX trigger_coordinated_events_run ON app.trigger_coordinated_events USING btree (workspace_id, run_id) WHERE (run_id IS NOT NULL);


--
-- Name: trigger_event_windows_expiry; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX trigger_event_windows_expiry ON app.trigger_event_windows USING btree (workspace_id, expires_at);


--
-- Name: trigger_schedule_occurrences_trigger_time_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX trigger_schedule_occurrences_trigger_time_idx ON app.trigger_schedule_occurrences USING btree (workspace_id, trigger_id, scheduled_at DESC, id);


--
-- Name: trigger_schedules_due_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX trigger_schedules_due_idx ON app.trigger_schedules USING btree (next_fire_at, workspace_id, trigger_id) WHERE ((status)::text = 'enabled'::text);


--
-- Name: usage_events_coordinated_history_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX usage_events_coordinated_history_idx ON app.usage_events USING btree (workspace_id, occurred_at, id) WHERE ((category)::text = 'trigger.coordinated'::text);


--
-- Name: usage_events_coordinated_retention_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX usage_events_coordinated_retention_idx ON app.usage_events USING btree (occurred_at, id) WHERE ((category)::text = 'trigger.coordinated'::text);


--
-- Name: usage_events_resource_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX usage_events_resource_idx ON app.usage_events USING btree (workspace_id, resource_type, resource_id, id);


--
-- Name: usage_events_trigger_skip_history_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX usage_events_trigger_skip_history_idx ON app.usage_events USING btree (workspace_id, resource_id, occurred_at DESC NULLS LAST, id) WHERE (((category)::text = 'trigger.skipped'::text) AND ((resource_type)::text = 'workflow'::text));


--
-- Name: usage_events_trigger_skip_retention_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX usage_events_trigger_skip_retention_idx ON app.usage_events USING btree (occurred_at, id) WHERE ((category)::text = 'trigger.skipped'::text);


--
-- Name: usage_events_workspace_period_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX usage_events_workspace_period_idx ON app.usage_events USING btree (workspace_id, occurred_at DESC, id);


--
-- Name: user_profile_command_receipts_key_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX user_profile_command_receipts_key_unique ON app.user_profile_command_receipts USING btree (actor_user_id, key_hash);


--
-- Name: users_email_canonical_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX users_email_canonical_idx ON app.users USING btree (lower(NORMALIZE((email)::text, NFKC)));


--
-- Name: users_email_lower_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX users_email_lower_unique ON app.users USING btree (lower((email)::text));


--
-- Name: version_promotion_source_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX version_promotion_source_idx ON app.workflow_version_promotions USING btree (workspace_id, source_workspace_id, source_workflow_id, source_version_id);


--
-- Name: webhook_deliveries_retention_dry_run_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX webhook_deliveries_retention_dry_run_idx ON app.webhook_trigger_deliveries USING btree (workspace_id, expires_at, id);


--
-- Name: webhook_deliveries_run_retention_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX webhook_deliveries_run_retention_idx ON app.webhook_trigger_deliveries USING btree (workspace_id, workflow_run_id) WHERE (workflow_run_id IS NOT NULL);


--
-- Name: webhook_replay_delivery_retention_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX webhook_replay_delivery_retention_idx ON app.webhook_trigger_replay_records USING btree (workspace_id, delivery_id, expires_at) WHERE (delivery_id IS NOT NULL);


--
-- Name: webhook_replay_retention_dry_run_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX webhook_replay_retention_dry_run_idx ON app.webhook_trigger_replay_records USING btree (workspace_id, expires_at, endpoint_id, dedupe_key_hash);


--
-- Name: webhook_replay_run_retention_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX webhook_replay_run_retention_idx ON app.webhook_trigger_replay_records USING btree (workspace_id, workflow_run_id) WHERE (workflow_run_id IS NOT NULL);


--
-- Name: webhook_test_events_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX webhook_test_events_expiry_idx ON app.webhook_test_events USING btree (expires_at, id);


--
-- Name: webhook_trigger_deliveries_endpoint_time_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX webhook_trigger_deliveries_endpoint_time_idx ON app.webhook_trigger_deliveries USING btree (workspace_id, endpoint_id, received_at DESC, id);


--
-- Name: webhook_trigger_deliveries_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX webhook_trigger_deliveries_expiry_idx ON app.webhook_trigger_deliveries USING btree (expires_at, id);


--
-- Name: webhook_trigger_replay_records_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX webhook_trigger_replay_records_expiry_idx ON app.webhook_trigger_replay_records USING btree (expires_at, endpoint_id);


--
-- Name: workflow_calls_live_child_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_calls_live_child_idx ON app.workflow_calls USING btree (workspace_id, live_child_run_id) WHERE (live_child_run_id IS NOT NULL);


--
-- Name: workflow_calls_one_loan_per_parent_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX workflow_calls_one_loan_per_parent_idx ON app.workflow_calls USING btree (workspace_id, parent_run_id) WHERE slot_lent;


--
-- Name: workflow_drafts_workspace_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_drafts_workspace_idx ON app.workflow_drafts USING btree (workspace_id, workflow_id);


--
-- Name: workflow_error_policies_target_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_error_policies_target_idx ON app.workflow_error_policies USING btree (workspace_id, target_workflow_id);


--
-- Name: workflow_failure_notification_policies_destination_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_failure_notification_policies_destination_idx ON app.workflow_failure_notification_policies USING btree (workspace_id, destination_id, workflow_id);


--
-- Name: workflow_favorites_workflow_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_favorites_workflow_idx ON app.workflow_favorites USING btree (workspace_id, workflow_id, actor_id);


--
-- Name: workflow_folder_grants_group_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_folder_grants_group_idx ON app.workflow_folder_grants USING btree (workspace_id, organization_id, group_id, folder_id);


--
-- Name: workflow_folder_grants_member_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_folder_grants_member_idx ON app.workflow_folder_grants USING btree (workspace_id, user_id, folder_id);


--
-- Name: workflow_folders_parent_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_folders_parent_idx ON app.workflow_folders USING btree (workspace_id, parent_id, id);


--
-- Name: workflow_input_cases_page_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_input_cases_page_idx ON app.workflow_input_cases USING btree (workspace_id, workflow_id, created_at, id) WHERE (deleted_at IS NULL);


--
-- Name: workflow_integration_usage_connection_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_integration_usage_connection_idx ON app.workflow_integration_usage USING btree (workspace_id, connection_id, workflow_version_id, provider_key, operation_key);


--
-- Name: workflow_integration_usage_impact_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_integration_usage_impact_idx ON app.workflow_integration_usage USING btree (workspace_id, provider_key, operation_key, workflow_version_id, connection_id);


--
-- Name: workflow_manual_start_rejections_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_manual_start_rejections_expiry_idx ON app.workflow_manual_start_rejections USING btree (expires_at, workspace_id, scope, key_hash);


--
-- Name: workflow_organization_state_folder_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_organization_state_folder_idx ON app.workflow_organization_state USING btree (workspace_id, folder_id, workflow_id);


--
-- Name: workflow_run_active_admissions_workspace_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_run_active_admissions_workspace_idx ON app.workflow_run_active_admissions USING btree (workspace_id);


--
-- Name: workflow_run_values_lookup_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_run_values_lookup_idx ON app.workflow_run_values USING btree (workspace_id, key, value, workflow_run_id);


--
-- Name: workflow_runs_detail_retention_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_runs_detail_retention_idx ON app.workflow_runs USING btree (workspace_id, completed_at, id) WHERE ((completed_at IS NOT NULL) AND (details_purged_at IS NULL));


--
-- Name: workflow_runs_due_deadline_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_runs_due_deadline_idx ON app.workflow_runs USING btree (deadline_at, id) WHERE ((deadline_at IS NOT NULL) AND ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('waiting'::character varying)::text])) AND (deadline_wakeup_at IS NULL));


--
-- Name: workflow_runs_due_input_ref_retention_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_runs_due_input_ref_retention_idx ON app.workflow_runs USING btree (workspace_id, input_ref_expires_at, id) WHERE (input_ref IS NOT NULL);


--
-- Name: workflow_runs_one_active_test; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX workflow_runs_one_active_test ON app.workflow_runs USING btree (workspace_id, workflow_id, started_by) WHERE (((trigger_type)::text = 'test'::text) AND ((status)::text = ANY ((ARRAY['queued'::character varying, 'running'::character varying, 'waiting'::character varying])::text[])));


--
-- Name: workflow_runs_queued_admission_order_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_runs_queued_admission_order_idx ON app.workflow_runs USING btree (workspace_id, workflow_id, admission_ticket, id) WHERE ((status)::text = 'queued'::text);


--
-- Name: workflow_runs_replay_source_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_runs_replay_source_idx ON app.workflow_runs USING btree (workspace_id, replay_source_run_id, id) WHERE (replay_source_run_id IS NOT NULL);


--
-- Name: workflow_runs_summary_retention_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_runs_summary_retention_idx ON app.workflow_runs USING btree (workspace_id, completed_at, id) WHERE (completed_at IS NOT NULL);


--
-- Name: workflow_runs_test_source_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_runs_test_source_idx ON app.workflow_runs USING btree (workspace_id, workflow_version_id) WHERE ((trigger_type)::text = 'test'::text);


--
-- Name: workflow_runs_variable_set_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_runs_variable_set_idx ON app.workflow_runs USING btree (workspace_id, variable_set_revision) WHERE (variable_set_revision IS NOT NULL);


--
-- Name: workflow_runs_workflow_active_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_runs_workflow_active_idx ON app.workflow_runs USING btree (workspace_id, workflow_id, id) WHERE ((status)::text = ANY (ARRAY[('running'::character varying)::text, ('waiting'::character varying)::text]));


--
-- Name: workflow_runs_workflow_version_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_runs_workflow_version_idx ON app.workflow_runs USING btree (workspace_id, workflow_version_id, id);


--
-- Name: workflow_runs_workspace_created_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_runs_workspace_created_idx ON app.workflow_runs USING btree (workspace_id, created_at, id);


--
-- Name: workflow_runs_workspace_created_statistics_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_runs_workspace_created_statistics_idx ON app.workflow_runs USING btree (workspace_id, created_at) INCLUDE (status, workflow_id);


--
-- Name: workflow_runs_workspace_status_created_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_runs_workspace_status_created_idx ON app.workflow_runs USING btree (workspace_id, status, created_at DESC, id DESC);


--
-- Name: workflow_runs_workspace_workflow_created_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_runs_workspace_workflow_created_idx ON app.workflow_runs USING btree (workspace_id, workflow_id, created_at, id);


--
-- Name: workflow_step_samples_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_step_samples_expiry_idx ON app.workflow_step_samples USING btree (expires_at, id);


--
-- Name: workflow_tag_assignments_tag_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_tag_assignments_tag_idx ON app.workflow_tag_assignments USING btree (workspace_id, tag_id, workflow_id);


--
-- Name: workflow_test_suite_cases_one_running; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX workflow_test_suite_cases_one_running ON app.workflow_test_suite_cases USING btree (workspace_id, suite_id) WHERE ((status)::text = 'running'::text);


--
-- Name: workflow_test_suite_cases_run_key; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX workflow_test_suite_cases_run_key ON app.workflow_test_suite_cases USING btree (workspace_id, run_id) WHERE (run_id IS NOT NULL);


--
-- Name: workflow_test_suites_active_starter_key; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX workflow_test_suites_active_starter_key ON app.workflow_test_suites USING btree (workspace_id, workflow_id, started_by) WHERE ((status)::text = 'running'::text);


--
-- Name: workflow_test_suites_due_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_test_suites_due_idx ON app.workflow_test_suites USING btree (next_check_at, id) WHERE ((status)::text = 'running'::text);


--
-- Name: workflow_test_suites_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_test_suites_expiry_idx ON app.workflow_test_suites USING btree (expires_at, id);


--
-- Name: workflow_test_suites_history_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_test_suites_history_idx ON app.workflow_test_suites USING btree (workspace_id, workflow_id, created_at, id);


--
-- Name: workflow_trigger_failures_order_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_trigger_failures_order_idx ON app.workflow_trigger_failures USING btree (workspace_id, workflow_id, ended_at, id);


--
-- Name: workflow_trigger_failures_run_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX workflow_trigger_failures_run_unique ON app.workflow_trigger_failures USING btree (workspace_id, run_id);


--
-- Name: workflow_trigger_outcomes_pending_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_trigger_outcomes_pending_idx ON app.workflow_trigger_outcomes USING btree (created_at, id);


--
-- Name: workflow_trigger_outcomes_run_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX workflow_trigger_outcomes_run_unique ON app.workflow_trigger_outcomes USING btree (workspace_id, run_id);


--
-- Name: workflow_trigger_outcomes_success_order_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_trigger_outcomes_success_order_idx ON app.workflow_trigger_outcomes USING btree (workspace_id, workflow_id, ended_at DESC NULLS LAST, id DESC NULLS LAST) WHERE (NOT counts_as_failure);


--
-- Name: workflow_trigger_outcomes_workflow_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_trigger_outcomes_workflow_idx ON app.workflow_trigger_outcomes USING btree (workspace_id, workflow_id);


--
-- Name: workflow_trigger_pause_periods_due_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_trigger_pause_periods_due_idx ON app.workflow_trigger_pause_periods USING btree (workspace_id, workflow_id, paused_at DESC) INCLUDE (resumed_at);


--
-- Name: workflow_triggers_active_kind_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_triggers_active_kind_idx ON app.workflow_triggers USING btree (workspace_id, kind, status, id) WHERE ((status)::text = ANY (ARRAY[('configuration_required'::character varying)::text, ('pending'::character varying)::text, ('active'::character varying)::text, ('degraded'::character varying)::text]));


--
-- Name: workflow_triggers_workflow_version_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_triggers_workflow_version_idx ON app.workflow_triggers USING btree (workspace_id, workflow_id, workflow_version_id, node_id);


--
-- Name: workflow_version_dependencies_target_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_version_dependencies_target_idx ON app.workflow_version_dependencies USING btree (workspace_id, target_workflow_id, parent_version_id);


--
-- Name: workflow_versions_reuse_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_versions_reuse_idx ON app.workflow_versions USING btree (workspace_id, workflow_id, checksum, version_number DESC);


--
-- Name: workflow_versions_workspace_workflow_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflow_versions_workspace_workflow_idx ON app.workflow_versions USING btree (workspace_id, workflow_id, version_number DESC);


--
-- Name: workflows_workspace_created_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflows_workspace_created_idx ON app.workflows USING btree (workspace_id, created_at, id);


--
-- Name: workflows_workspace_name_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflows_workspace_name_idx ON app.workflows USING btree (workspace_id, name, id);


--
-- Name: workflows_workspace_updated_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workflows_workspace_updated_idx ON app.workflows USING btree (workspace_id, updated_at DESC, id DESC);


--
-- Name: workspace_creation_idempotency_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_creation_idempotency_expiry_idx ON app.workspace_creation_idempotency_records USING btree (expires_at, id);


--
-- Name: workspace_data_table_rows_page; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_data_table_rows_page ON app.workspace_data_table_rows USING btree (workspace_id, table_id, id);


--
-- Name: workspace_execution_entitlement_versions_workspace_time_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_execution_entitlement_versions_workspace_time_idx ON app.workspace_execution_entitlement_versions USING btree (workspace_id, effective_at DESC, version DESC);


--
-- Name: workspace_inbox_events_pending_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_inbox_events_pending_idx ON app.workspace_inbox_events USING btree (created_at, id);


--
-- Name: workspace_inbox_events_terminal_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX workspace_inbox_events_terminal_unique ON app.workspace_inbox_events USING btree (workspace_id, run_id, terminal_event_sequence);


--
-- Name: workspace_inbox_events_workflow_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_inbox_events_workflow_idx ON app.workspace_inbox_events USING btree (workspace_id, workflow_id);


--
-- Name: workspace_inbox_failure_days_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_inbox_failure_days_expiry_idx ON app.workspace_inbox_failure_days USING btree (day, workspace_id, workflow_id);


--
-- Name: workspace_inbox_threads_capacity_limit_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX workspace_inbox_threads_capacity_limit_unique ON app.workspace_inbox_threads USING btree (workspace_id, capacity_limit) WHERE ((notice_kind)::text = 'limit_approaching'::text);


--
-- Name: workspace_inbox_threads_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_inbox_threads_expiry_idx ON app.workspace_inbox_threads USING btree (latest_occurred_at, workspace_id, id);


--
-- Name: workspace_inbox_threads_recent_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_inbox_threads_recent_idx ON app.workspace_inbox_threads USING btree (workspace_id, latest_occurred_at DESC, id DESC);


--
-- Name: workspace_inbox_threads_subject_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX workspace_inbox_threads_subject_unique ON app.workspace_inbox_threads USING btree (workspace_id, notice_kind, subject_id);


--
-- Name: workspace_invitation_binding_replacement_cleanup_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_invitation_binding_replacement_cleanup_idx ON app.workspace_invitation_binding_replacement_claims USING btree (updated_at, prior_workspace_id, prior_intent_id);


--
-- Name: workspace_invitation_binding_replacement_successor_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_invitation_binding_replacement_successor_idx ON app.workspace_invitation_binding_replacement_claims USING btree (successor_workspace_id, successor_intent_id, successor_binding_digest);


--
-- Name: workspace_invitation_delivery_generation_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX workspace_invitation_delivery_generation_unique ON app.workspace_invitation_delivery_attempts USING btree (invitation_id, invitation_revision);


--
-- Name: workspace_invitation_delivery_workspace_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_invitation_delivery_workspace_idx ON app.workspace_invitation_delivery_attempts USING btree (workspace_id, created_at, id);


--
-- Name: workspace_invitation_intents_binding_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX workspace_invitation_intents_binding_unique ON app.workspace_invitation_acceptance_intents USING btree (workspace_id, binding_digest);


--
-- Name: workspace_invitation_intents_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_invitation_intents_expiry_idx ON app.workspace_invitation_acceptance_intents USING btree (expires_at, id);


--
-- Name: workspace_invitation_intents_invitation_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_invitation_intents_invitation_idx ON app.workspace_invitation_acceptance_intents USING btree (workspace_id, invitation_id, invitation_revision, id);


--
-- Name: workspace_invitations_expiry_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_invitations_expiry_idx ON app.workspace_invitations USING btree (expires_at, id) WHERE ((status)::text = 'pending'::text);


--
-- Name: workspace_invitations_list_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_invitations_list_idx ON app.workspace_invitations USING btree (workspace_id, created_at DESC, id DESC);


--
-- Name: workspace_invitations_pending_recipient_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX workspace_invitations_pending_recipient_unique ON app.workspace_invitations USING btree (workspace_id, normalized_email) WHERE ((status)::text = 'pending'::text);


--
-- Name: workspace_invitations_token_digest_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX workspace_invitations_token_digest_unique ON app.workspace_invitations USING btree (workspace_id, id, token_digest);


--
-- Name: workspace_memberships_one_owner_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX workspace_memberships_one_owner_unique ON app.workspace_memberships USING btree (workspace_id) WHERE (((role)::text = 'owner'::text) AND ((status)::text <> 'removed'::text));


--
-- Name: workspace_memberships_user_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_memberships_user_idx ON app.workspace_memberships USING btree (user_id, workspace_id);


--
-- Name: workspace_memberships_workspace_created_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_memberships_workspace_created_idx ON app.workspace_memberships USING btree (workspace_id, created_at, user_id) WHERE ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text]));


--
-- Name: workspace_memberships_workspace_status_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspace_memberships_workspace_status_idx ON app.workspace_memberships USING btree (workspace_id, status, user_id);


--
-- Name: workspaces_slug_lower_unique; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE UNIQUE INDEX workspaces_slug_lower_unique ON app.workspaces USING btree (lower((slug)::text));


--
-- Name: workspaces_status_purge_idx; Type: INDEX; Schema: app; Owner: pertexo_owner
--

CREATE INDEX workspaces_status_purge_idx ON app.workspaces USING btree (status, purge_after, id) WHERE ((status)::text = ANY (ARRAY[('pending_deletion'::character varying)::text, ('purging'::character varying)::text]));


--
-- Name: artifacts artifacts_capacity_transition; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER artifacts_capacity_transition BEFORE INSERT OR DELETE OR UPDATE OF workspace_id, byte_length, purpose, storage_key, media_type, sha256, status, created_at ON app.artifacts FOR EACH ROW EXECUTE FUNCTION app.artifact_capacity_transition();


--
-- Name: node_attempts node_attempts_artifact_owner_delete; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER node_attempts_artifact_owner_delete AFTER DELETE ON app.node_attempts FOR EACH ROW WHEN ((COALESCE(jsonb_path_exists((old.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists(old.reconciliation_ref, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false))) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"output_ref":"value","reconciliation_ref":"value"}');


--
-- Name: node_attempts node_attempts_artifact_owner_insert; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER node_attempts_artifact_owner_insert AFTER INSERT ON app.node_attempts FOR EACH ROW WHEN ((COALESCE(jsonb_path_exists((new.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists(new.reconciliation_ref, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false))) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"output_ref":"value","reconciliation_ref":"value"}');


--
-- Name: node_attempts node_attempts_artifact_owner_truncate; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER node_attempts_artifact_owner_truncate AFTER TRUNCATE ON app.node_attempts FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"output_ref":"value","reconciliation_ref":"value"}');


--
-- Name: node_attempts node_attempts_artifact_owner_update; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER node_attempts_artifact_owner_update AFTER UPDATE OF workspace_id, id, output_ref, reconciliation_ref ON app.node_attempts FOR EACH ROW WHEN ((((((old.workspace_id IS DISTINCT FROM new.workspace_id) OR (old.id IS DISTINCT FROM new.id)) OR ((old.output_ref)::jsonb IS DISTINCT FROM (new.output_ref)::jsonb)) OR (old.reconciliation_ref IS DISTINCT FROM new.reconciliation_ref)) AND (COALESCE(jsonb_path_exists((old.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists(old.reconciliation_ref, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((new.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists(new.reconciliation_ref, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)))) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"output_ref":"value","reconciliation_ref":"value"}');


--
-- Name: node_attempts node_attempts_lock_artifact_references; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER node_attempts_lock_artifact_references BEFORE INSERT OR UPDATE OF output_ref, reconciliation_ref ON app.node_attempts FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();


--
-- Name: node_attempts node_attempts_output_ref_bytes; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER node_attempts_output_ref_bytes BEFORE INSERT OR UPDATE OF output_ref ON app.node_attempts FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('output_ref', '4194304', 'node_attempts_output_ref_bounded');


--
-- Name: node_runs node_runs_artifact_owner_delete; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER node_runs_artifact_owner_delete AFTER DELETE ON app.node_runs FOR EACH ROW WHEN ((COALESCE(jsonb_path_exists((old.input_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((old.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false))) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"input_ref":"value","output_ref":"value"}');


--
-- Name: node_runs node_runs_artifact_owner_insert; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER node_runs_artifact_owner_insert AFTER INSERT ON app.node_runs FOR EACH ROW WHEN ((COALESCE(jsonb_path_exists((new.input_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((new.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false))) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"input_ref":"value","output_ref":"value"}');


--
-- Name: node_runs node_runs_artifact_owner_truncate; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER node_runs_artifact_owner_truncate AFTER TRUNCATE ON app.node_runs FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"input_ref":"value","output_ref":"value"}');


--
-- Name: node_runs node_runs_artifact_owner_update; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER node_runs_artifact_owner_update AFTER UPDATE OF workspace_id, id, input_ref, output_ref ON app.node_runs FOR EACH ROW WHEN ((((((old.workspace_id IS DISTINCT FROM new.workspace_id) OR (old.id IS DISTINCT FROM new.id)) OR ((old.input_ref)::jsonb IS DISTINCT FROM (new.input_ref)::jsonb)) OR ((old.output_ref)::jsonb IS DISTINCT FROM (new.output_ref)::jsonb)) AND (COALESCE(jsonb_path_exists((old.input_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((old.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((new.input_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((new.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)))) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"input_ref":"value","output_ref":"value"}');


--
-- Name: node_runs node_runs_input_ref_bytes; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER node_runs_input_ref_bytes BEFORE INSERT OR UPDATE OF input_ref ON app.node_runs FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('input_ref', '4194304', 'node_runs_input_ref_bounded');


--
-- Name: node_runs node_runs_lock_artifact_references; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER node_runs_lock_artifact_references BEFORE INSERT OR UPDATE OF input_ref, output_ref ON app.node_runs FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();


--
-- Name: node_runs node_runs_output_ref_bytes; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER node_runs_output_ref_bytes BEFORE INSERT OR UPDATE OF output_ref ON app.node_runs FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('output_ref', '4194304', 'node_runs_output_ref_bounded');


--
-- Name: outbox_events outbox_events_signal_rows; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER outbox_events_signal_rows AFTER INSERT ON app.outbox_events REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.signal_outbox_rows();


--
-- Name: pending_run_tasks pending_run_tasks_artifact_owner_delete; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER pending_run_tasks_artifact_owner_delete AFTER DELETE ON app.pending_run_tasks FOR EACH ROW WHEN (COALESCE(jsonb_path_exists((old.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"output_ref":"value"}');


--
-- Name: pending_run_tasks pending_run_tasks_artifact_owner_insert; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER pending_run_tasks_artifact_owner_insert AFTER INSERT ON app.pending_run_tasks FOR EACH ROW WHEN (COALESCE(jsonb_path_exists((new.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"output_ref":"value"}');


--
-- Name: pending_run_tasks pending_run_tasks_artifact_owner_truncate; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER pending_run_tasks_artifact_owner_truncate AFTER TRUNCATE ON app.pending_run_tasks FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"output_ref":"value"}');


--
-- Name: pending_run_tasks pending_run_tasks_artifact_owner_update; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER pending_run_tasks_artifact_owner_update AFTER UPDATE OF workspace_id, id, output_ref ON app.pending_run_tasks FOR EACH ROW WHEN (((((old.workspace_id IS DISTINCT FROM new.workspace_id) OR (old.id IS DISTINCT FROM new.id)) OR ((old.output_ref)::jsonb IS DISTINCT FROM (new.output_ref)::jsonb)) AND (COALESCE(jsonb_path_exists((old.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((new.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)))) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"output_ref":"value"}');


--
-- Name: pending_run_tasks pending_run_tasks_output_ref_bytes; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER pending_run_tasks_output_ref_bytes BEFORE INSERT OR UPDATE OF output_ref ON app.pending_run_tasks FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('output_ref', '4194304', 'pending_run_tasks_output_bounded');


--
-- Name: preview_attempts preview_attempts_output_ref_bytes; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER preview_attempts_output_ref_bytes BEFORE INSERT OR UPDATE OF output_ref ON app.preview_attempts FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('output_ref', '4194304', 'preview_attempts_output_bounded');


--
-- Name: preview_runs preview_runs_artifact_owner_delete; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER preview_runs_artifact_owner_delete AFTER DELETE ON app.preview_runs FOR EACH ROW WHEN ((COALESCE(jsonb_path_exists((old.input_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((old.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((old.executable_node_json)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false))) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"input_ref":"value","output_ref":"value","executable_node_json":"authored"}');


--
-- Name: preview_runs preview_runs_artifact_owner_insert; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER preview_runs_artifact_owner_insert AFTER INSERT ON app.preview_runs FOR EACH ROW WHEN ((COALESCE(jsonb_path_exists((new.input_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((new.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((new.executable_node_json)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false))) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"input_ref":"value","output_ref":"value","executable_node_json":"authored"}');


--
-- Name: preview_runs preview_runs_artifact_owner_truncate; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER preview_runs_artifact_owner_truncate AFTER TRUNCATE ON app.preview_runs FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"input_ref":"value","output_ref":"value","executable_node_json":"authored"}');


--
-- Name: preview_runs preview_runs_artifact_owner_update; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER preview_runs_artifact_owner_update AFTER UPDATE OF workspace_id, id, input_ref, output_ref, executable_node_json ON app.preview_runs FOR EACH ROW WHEN (((((((old.workspace_id IS DISTINCT FROM new.workspace_id) OR (old.id IS DISTINCT FROM new.id)) OR ((old.input_ref)::jsonb IS DISTINCT FROM (new.input_ref)::jsonb)) OR ((old.output_ref)::jsonb IS DISTINCT FROM (new.output_ref)::jsonb)) OR ((old.executable_node_json)::jsonb IS DISTINCT FROM (new.executable_node_json)::jsonb)) AND (COALESCE(jsonb_path_exists((old.input_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((old.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((old.executable_node_json)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((new.input_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((new.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((new.executable_node_json)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)))) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"input_ref":"value","output_ref":"value","executable_node_json":"authored"}');


--
-- Name: preview_runs preview_runs_executable_node_json_bytes; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER preview_runs_executable_node_json_bytes BEFORE INSERT OR UPDATE OF executable_node_json ON app.preview_runs FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('executable_node_json', '2097152', 'preview_runs_node_bounded');


--
-- Name: preview_runs preview_runs_input_ref_bytes; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER preview_runs_input_ref_bytes BEFORE INSERT OR UPDATE OF input_ref ON app.preview_runs FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('input_ref', '4194304', 'preview_runs_input_bounded');


--
-- Name: preview_runs preview_runs_output_ref_bytes; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER preview_runs_output_ref_bytes BEFORE INSERT OR UPDATE OF output_ref ON app.preview_runs FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('output_ref', '4194304', 'preview_runs_output_bounded');


--
-- Name: run_checkpoints run_checkpoints_artifact_owner_delete; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER run_checkpoints_artifact_owner_delete AFTER DELETE ON app.run_checkpoints FOR EACH ROW WHEN (COALESCE(jsonb_path_exists(old.scheduler_state, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)) EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id', '', '{"scheduler_state":"checkpoint"}');


--
-- Name: run_checkpoints run_checkpoints_artifact_owner_insert; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER run_checkpoints_artifact_owner_insert AFTER INSERT ON app.run_checkpoints FOR EACH ROW WHEN (COALESCE(jsonb_path_exists(new.scheduler_state, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)) EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id', '', '{"scheduler_state":"checkpoint"}');


--
-- Name: run_checkpoints run_checkpoints_artifact_owner_truncate; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER run_checkpoints_artifact_owner_truncate AFTER TRUNCATE ON app.run_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id', '', '{"scheduler_state":"checkpoint"}');


--
-- Name: run_checkpoints run_checkpoints_artifact_owner_update; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER run_checkpoints_artifact_owner_update AFTER UPDATE OF workspace_id, workflow_run_id, scheduler_state ON app.run_checkpoints FOR EACH ROW WHEN (((((old.workspace_id IS DISTINCT FROM new.workspace_id) OR (old.workflow_run_id IS DISTINCT FROM new.workflow_run_id)) OR (old.scheduler_state IS DISTINCT FROM new.scheduler_state)) AND (COALESCE(jsonb_path_exists(old.scheduler_state, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists(new.scheduler_state, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)))) EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id', '', '{"scheduler_state":"checkpoint"}');


--
-- Name: run_checkpoints run_checkpoints_lock_artifact_references; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER run_checkpoints_lock_artifact_references BEFORE INSERT OR UPDATE OF scheduler_state ON app.run_checkpoints FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();


--
-- Name: run_events run_events_artifact_owner_delete; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER run_events_artifact_owner_delete AFTER DELETE ON app.run_events FOR EACH ROW WHEN (COALESCE(jsonb_path_exists(old.payload, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)) EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id', 'sequence', '{"payload":"event"}');


--
-- Name: run_events run_events_artifact_owner_insert; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER run_events_artifact_owner_insert AFTER INSERT ON app.run_events FOR EACH ROW WHEN (COALESCE(jsonb_path_exists(new.payload, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)) EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id', 'sequence', '{"payload":"event"}');


--
-- Name: run_events run_events_artifact_owner_truncate; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER run_events_artifact_owner_truncate AFTER TRUNCATE ON app.run_events FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id', 'sequence', '{"payload":"event"}');


--
-- Name: run_events run_events_artifact_owner_update; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER run_events_artifact_owner_update AFTER UPDATE OF workspace_id, workflow_run_id, sequence, payload ON app.run_events FOR EACH ROW WHEN ((((((old.workspace_id IS DISTINCT FROM new.workspace_id) OR (old.workflow_run_id IS DISTINCT FROM new.workflow_run_id)) OR (old.sequence IS DISTINCT FROM new.sequence)) OR (old.payload IS DISTINCT FROM new.payload)) AND (COALESCE(jsonb_path_exists(old.payload, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists(new.payload, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)))) EXECUTE FUNCTION app.index_artifact_owner_references('workflow_run_id', 'sequence', '{"payload":"event"}');


--
-- Name: run_events run_events_lock_artifact_references; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER run_events_lock_artifact_references BEFORE INSERT OR UPDATE OF payload ON app.run_events FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();


--
-- Name: users users_revoke_auth_sessions_on_deactivation; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER users_revoke_auth_sessions_on_deactivation AFTER UPDATE OF status ON app.users FOR EACH ROW EXECUTE FUNCTION app.revoke_auth_sessions_for_inactive_user();


--
-- Name: users users_revoke_auth_sessions_on_email_change; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER users_revoke_auth_sessions_on_email_change AFTER UPDATE OF email ON app.users FOR EACH ROW WHEN (((old.email)::text IS DISTINCT FROM (new.email)::text)) EXECUTE FUNCTION app.revoke_auth_sessions_for_email_change();


--
-- Name: workflow_drafts workflow_drafts_artifact_owner_delete; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_drafts_artifact_owner_delete AFTER DELETE ON app.workflow_drafts FOR EACH ROW WHEN (COALESCE(jsonb_path_exists((old.graph_json)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)) EXECUTE FUNCTION app.index_artifact_owner_references('workflow_id', '', '{"graph_json":"authored"}');


--
-- Name: workflow_drafts workflow_drafts_artifact_owner_insert; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_drafts_artifact_owner_insert AFTER INSERT ON app.workflow_drafts FOR EACH ROW WHEN (COALESCE(jsonb_path_exists((new.graph_json)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)) EXECUTE FUNCTION app.index_artifact_owner_references('workflow_id', '', '{"graph_json":"authored"}');


--
-- Name: workflow_drafts workflow_drafts_artifact_owner_truncate; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_drafts_artifact_owner_truncate AFTER TRUNCATE ON app.workflow_drafts FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('workflow_id', '', '{"graph_json":"authored"}');


--
-- Name: workflow_drafts workflow_drafts_artifact_owner_update; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_drafts_artifact_owner_update AFTER UPDATE OF workspace_id, workflow_id, graph_json ON app.workflow_drafts FOR EACH ROW WHEN (((((old.workspace_id IS DISTINCT FROM new.workspace_id) OR (old.workflow_id IS DISTINCT FROM new.workflow_id)) OR ((old.graph_json)::jsonb IS DISTINCT FROM (new.graph_json)::jsonb)) AND (COALESCE(jsonb_path_exists((old.graph_json)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((new.graph_json)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)))) EXECUTE FUNCTION app.index_artifact_owner_references('workflow_id', '', '{"graph_json":"authored"}');


--
-- Name: workflow_input_case_payloads workflow_input_case_payloads_artifact_owner_delete; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_input_case_payloads_artifact_owner_delete AFTER DELETE ON app.workflow_input_case_payloads FOR EACH ROW WHEN (COALESCE(app.artifact_owner_text_may_reference(old.input), false)) EXECUTE FUNCTION app.index_artifact_owner_references('case_id', 'revision', '{"input":"authored-text"}');


--
-- Name: workflow_input_case_payloads workflow_input_case_payloads_artifact_owner_insert; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_input_case_payloads_artifact_owner_insert AFTER INSERT ON app.workflow_input_case_payloads FOR EACH ROW WHEN (COALESCE(app.artifact_owner_text_may_reference(new.input), false)) EXECUTE FUNCTION app.index_artifact_owner_references('case_id', 'revision', '{"input":"authored-text"}');


--
-- Name: workflow_input_case_payloads workflow_input_case_payloads_artifact_owner_truncate; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_input_case_payloads_artifact_owner_truncate AFTER TRUNCATE ON app.workflow_input_case_payloads FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('case_id', 'revision', '{"input":"authored-text"}');


--
-- Name: workflow_input_case_payloads workflow_input_case_payloads_artifact_owner_update; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_input_case_payloads_artifact_owner_update AFTER UPDATE OF workspace_id, case_id, revision, input ON app.workflow_input_case_payloads FOR EACH ROW WHEN ((((((old.workspace_id IS DISTINCT FROM new.workspace_id) OR (old.case_id IS DISTINCT FROM new.case_id)) OR (old.revision IS DISTINCT FROM new.revision)) OR (old.input IS DISTINCT FROM new.input)) AND (COALESCE(app.artifact_owner_text_may_reference(old.input), false) OR COALESCE(app.artifact_owner_text_may_reference(new.input), false)))) EXECUTE FUNCTION app.index_artifact_owner_references('case_id', 'revision', '{"input":"authored-text"}');


--
-- Name: workflow_runs workflow_run_skip_protocol; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_run_skip_protocol BEFORE INSERT ON app.workflow_runs FOR EACH ROW EXECUTE FUNCTION app.require_workflow_skip_protocol();


--
-- Name: workflow_runs workflow_runs_artifact_owner_delete; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_runs_artifact_owner_delete AFTER DELETE ON app.workflow_runs FOR EACH ROW WHEN ((COALESCE(jsonb_path_exists((old.input_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((old.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false))) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"input_ref":"value","output_ref":"value"}');


--
-- Name: workflow_runs workflow_runs_artifact_owner_insert; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_runs_artifact_owner_insert AFTER INSERT ON app.workflow_runs FOR EACH ROW WHEN ((COALESCE(jsonb_path_exists((new.input_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((new.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false))) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"input_ref":"value","output_ref":"value"}');


--
-- Name: workflow_runs workflow_runs_artifact_owner_truncate; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_runs_artifact_owner_truncate AFTER TRUNCATE ON app.workflow_runs FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"input_ref":"value","output_ref":"value"}');


--
-- Name: workflow_runs workflow_runs_artifact_owner_update; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_runs_artifact_owner_update AFTER UPDATE OF workspace_id, id, input_ref, output_ref ON app.workflow_runs FOR EACH ROW WHEN ((((((old.workspace_id IS DISTINCT FROM new.workspace_id) OR (old.id IS DISTINCT FROM new.id)) OR ((old.input_ref)::jsonb IS DISTINCT FROM (new.input_ref)::jsonb)) OR ((old.output_ref)::jsonb IS DISTINCT FROM (new.output_ref)::jsonb)) AND (COALESCE(jsonb_path_exists((old.input_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((old.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((new.input_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((new.output_ref)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)))) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"input_ref":"value","output_ref":"value"}');


--
-- Name: workflow_runs workflow_runs_execution_admission; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_runs_execution_admission BEFORE INSERT OR UPDATE OF workspace_id, status, execution_entitlement_version, human_wait_started_at, timed_wait_started_at ON app.workflow_runs FOR EACH ROW EXECUTE FUNCTION app.enforce_workflow_run_admission();


--
-- Name: workflow_runs workflow_runs_input_ref_bytes; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_runs_input_ref_bytes BEFORE INSERT OR UPDATE OF input_ref ON app.workflow_runs FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('input_ref', '4194304', 'workflow_runs_input_ref_bounded');


--
-- Name: workflow_runs workflow_runs_lock_artifact_references; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_runs_lock_artifact_references BEFORE INSERT OR UPDATE OF input_ref, output_ref ON app.workflow_runs FOR EACH ROW EXECUTE FUNCTION app.lock_execution_artifact_references();


--
-- Name: workflow_runs workflow_runs_output_ref_bytes; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_runs_output_ref_bytes BEFORE INSERT OR UPDATE OF output_ref ON app.workflow_runs FOR EACH ROW EXECUTE FUNCTION app.check_execution_value_bytes('output_ref', '4194304', 'workflow_runs_output_ref_bounded');


--
-- Name: workflow_runs workflow_runs_refresh_execution_admission; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_runs_refresh_execution_admission AFTER INSERT OR UPDATE OF workspace_id, status, execution_entitlement_version, human_wait_started_at, timed_wait_started_at ON app.workflow_runs FOR EACH ROW EXECUTE FUNCTION app.refresh_workflow_run_admission_counters();


--
-- Name: workflow_step_samples workflow_step_samples_artifact_owner_delete; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_step_samples_artifact_owner_delete AFTER DELETE ON app.workflow_step_samples FOR EACH ROW WHEN (COALESCE(app.artifact_owner_text_may_reference(old.output_ref), false)) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"output_ref":"value-text"}');


--
-- Name: workflow_step_samples workflow_step_samples_artifact_owner_insert; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_step_samples_artifact_owner_insert AFTER INSERT ON app.workflow_step_samples FOR EACH ROW WHEN (COALESCE(app.artifact_owner_text_may_reference(new.output_ref), false)) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"output_ref":"value-text"}');


--
-- Name: workflow_step_samples workflow_step_samples_artifact_owner_truncate; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_step_samples_artifact_owner_truncate AFTER TRUNCATE ON app.workflow_step_samples FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"output_ref":"value-text"}');


--
-- Name: workflow_step_samples workflow_step_samples_artifact_owner_update; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_step_samples_artifact_owner_update AFTER UPDATE OF workspace_id, id, output_ref ON app.workflow_step_samples FOR EACH ROW WHEN (((((old.workspace_id IS DISTINCT FROM new.workspace_id) OR (old.id IS DISTINCT FROM new.id)) OR (old.output_ref IS DISTINCT FROM new.output_ref)) AND (COALESCE(app.artifact_owner_text_may_reference(old.output_ref), false) OR COALESCE(app.artifact_owner_text_may_reference(new.output_ref), false)))) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"output_ref":"value-text"}');


--
-- Name: workflow_test_snapshots workflow_test_snapshots_artifact_owner_delete; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_test_snapshots_artifact_owner_delete AFTER DELETE ON app.workflow_test_snapshots FOR EACH ROW WHEN (COALESCE(jsonb_path_exists((old.graph_json)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"graph_json":"authored"}');


--
-- Name: workflow_test_snapshots workflow_test_snapshots_artifact_owner_insert; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_test_snapshots_artifact_owner_insert AFTER INSERT ON app.workflow_test_snapshots FOR EACH ROW WHEN (COALESCE(jsonb_path_exists((new.graph_json)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"graph_json":"authored"}');


--
-- Name: workflow_test_snapshots workflow_test_snapshots_artifact_owner_truncate; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_test_snapshots_artifact_owner_truncate AFTER TRUNCATE ON app.workflow_test_snapshots FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"graph_json":"authored"}');


--
-- Name: workflow_test_snapshots workflow_test_snapshots_artifact_owner_update; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_test_snapshots_artifact_owner_update AFTER UPDATE OF workspace_id, id, graph_json ON app.workflow_test_snapshots FOR EACH ROW WHEN (((((old.workspace_id IS DISTINCT FROM new.workspace_id) OR (old.id IS DISTINCT FROM new.id)) OR ((old.graph_json)::jsonb IS DISTINCT FROM (new.graph_json)::jsonb)) AND (COALESCE(jsonb_path_exists((old.graph_json)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((new.graph_json)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)))) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"graph_json":"authored"}');


--
-- Name: workflow_test_suite_cases workflow_test_suite_cases_artifact_owner_delete; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_test_suite_cases_artifact_owner_delete AFTER DELETE ON app.workflow_test_suite_cases FOR EACH ROW WHEN (COALESCE(app.artifact_owner_text_may_reference(old.input), false)) EXECUTE FUNCTION app.index_artifact_owner_references('suite_id', 'ordinal', '{"input":"authored-text"}');


--
-- Name: workflow_test_suite_cases workflow_test_suite_cases_artifact_owner_insert; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_test_suite_cases_artifact_owner_insert AFTER INSERT ON app.workflow_test_suite_cases FOR EACH ROW WHEN (COALESCE(app.artifact_owner_text_may_reference(new.input), false)) EXECUTE FUNCTION app.index_artifact_owner_references('suite_id', 'ordinal', '{"input":"authored-text"}');


--
-- Name: workflow_test_suite_cases workflow_test_suite_cases_artifact_owner_truncate; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_test_suite_cases_artifact_owner_truncate AFTER TRUNCATE ON app.workflow_test_suite_cases FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('suite_id', 'ordinal', '{"input":"authored-text"}');


--
-- Name: workflow_test_suite_cases workflow_test_suite_cases_artifact_owner_update; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_test_suite_cases_artifact_owner_update AFTER UPDATE OF workspace_id, suite_id, ordinal, input ON app.workflow_test_suite_cases FOR EACH ROW WHEN ((((((old.workspace_id IS DISTINCT FROM new.workspace_id) OR (old.suite_id IS DISTINCT FROM new.suite_id)) OR (old.ordinal IS DISTINCT FROM new.ordinal)) OR (old.input IS DISTINCT FROM new.input)) AND (COALESCE(app.artifact_owner_text_may_reference(old.input), false) OR COALESCE(app.artifact_owner_text_may_reference(new.input), false)))) EXECUTE FUNCTION app.index_artifact_owner_references('suite_id', 'ordinal', '{"input":"authored-text"}');


--
-- Name: workflow_versions workflow_versions_artifact_owner_delete; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_versions_artifact_owner_delete AFTER DELETE ON app.workflow_versions FOR EACH ROW WHEN (COALESCE(jsonb_path_exists((old.graph_json)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"graph_json":"authored"}');


--
-- Name: workflow_versions workflow_versions_artifact_owner_insert; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_versions_artifact_owner_insert AFTER INSERT ON app.workflow_versions FOR EACH ROW WHEN (COALESCE(jsonb_path_exists((new.graph_json)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"graph_json":"authored"}');


--
-- Name: workflow_versions workflow_versions_artifact_owner_truncate; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_versions_artifact_owner_truncate AFTER TRUNCATE ON app.workflow_versions FOR EACH STATEMENT EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"graph_json":"authored"}');


--
-- Name: workflow_versions workflow_versions_artifact_owner_update; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workflow_versions_artifact_owner_update AFTER UPDATE OF workspace_id, id, graph_json ON app.workflow_versions FOR EACH ROW WHEN (((((old.workspace_id IS DISTINCT FROM new.workspace_id) OR (old.id IS DISTINCT FROM new.id)) OR ((old.graph_json)::jsonb IS DISTINCT FROM (new.graph_json)::jsonb)) AND (COALESCE(jsonb_path_exists((old.graph_json)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false) OR COALESCE(jsonb_path_exists((new.graph_json)::jsonb, '$.**?((@."kind".type() == "string" && @."kind" == "artifact") && exists (@."artifactId"))'::jsonpath), false)))) EXECUTE FUNCTION app.index_artifact_owner_references('id', '', '{"graph_json":"authored"}');


--
-- Name: workspaces workspace_artifact_capacity_purge_start; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workspace_artifact_capacity_purge_start BEFORE UPDATE OF status ON app.workspaces FOR EACH ROW EXECUTE FUNCTION app.artifact_capacity_purge_start();


--
-- Name: workspaces workspaces_provision_execution_admission; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workspaces_provision_execution_admission AFTER INSERT ON app.workspaces FOR EACH ROW EXECUTE FUNCTION app.provision_workspace_execution_admission();


--
-- Name: workspaces workspaces_revoke_auth_sessions_on_unavailability; Type: TRIGGER; Schema: app; Owner: pertexo_owner
--

CREATE TRIGGER workspaces_revoke_auth_sessions_on_unavailability AFTER UPDATE OF status ON app.workspaces FOR EACH ROW WHEN ((((old.status)::text IS DISTINCT FROM (new.status)::text) AND ((new.status)::text = ANY (ARRAY[('suspended'::character varying)::text, ('pending_deletion'::character varying)::text, ('purging'::character varying)::text, ('deleted'::character varying)::text])))) EXECUTE FUNCTION app.revoke_auth_sessions_for_workspace_unavailability();


--
-- Name: api_tokens api_tokens_membership_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.api_tokens
    ADD CONSTRAINT api_tokens_membership_fk FOREIGN KEY (workspace_id, owner_user_id) REFERENCES app.workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT;


--
-- Name: artifact_links artifact_links_artifact_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.artifact_links
    ADD CONSTRAINT artifact_links_artifact_fk FOREIGN KEY (workspace_id, artifact_id) REFERENCES app.artifacts(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: artifact_links artifact_links_preview_run_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.artifact_links
    ADD CONSTRAINT artifact_links_preview_run_fk FOREIGN KEY (workspace_id, owner_id) REFERENCES app.preview_runs(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: artifact_owner_references artifact_owner_references_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.artifact_owner_references
    ADD CONSTRAINT artifact_owner_references_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;


--
-- Name: audit_events audit_events_actor_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.audit_events
    ADD CONSTRAINT audit_events_actor_fk FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: audit_events audit_events_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.audit_events
    ADD CONSTRAINT audit_events_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;


--
-- Name: auth_accounts auth_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_accounts
    ADD CONSTRAINT auth_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE;


--
-- Name: auth_directory_group_mappings auth_directory_group_mapping_group_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_group_mappings
    ADD CONSTRAINT auth_directory_group_mapping_group_fk FOREIGN KEY (organization_id, group_id) REFERENCES app.auth_directory_groups(organization_id, id) ON DELETE CASCADE;


--
-- Name: auth_directory_group_mappings auth_directory_group_mapping_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_group_mappings
    ADD CONSTRAINT auth_directory_group_mapping_workspace_fk FOREIGN KEY (organization_id, workspace_id) REFERENCES app.auth_organization_workspaces(organization_id, workspace_id) ON DELETE CASCADE;


--
-- Name: auth_directory_group_members auth_directory_group_member_group_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_group_members
    ADD CONSTRAINT auth_directory_group_member_group_fk FOREIGN KEY (organization_id, group_id) REFERENCES app.auth_directory_groups(organization_id, id) ON DELETE CASCADE;


--
-- Name: auth_directory_group_members auth_directory_group_member_user_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_group_members
    ADD CONSTRAINT auth_directory_group_member_user_fk FOREIGN KEY (organization_id, directory_user_id) REFERENCES app.auth_directory_users(organization_id, id) ON DELETE CASCADE;


--
-- Name: auth_directory_groups auth_directory_group_org_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_groups
    ADD CONSTRAINT auth_directory_group_org_fk FOREIGN KEY (organization_id) REFERENCES app.auth_organizations(id) ON DELETE CASCADE;


--
-- Name: auth_directory_memberships auth_directory_membership_identity_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_memberships
    ADD CONSTRAINT auth_directory_membership_identity_fk FOREIGN KEY (organization_id, directory_user_id, user_id) REFERENCES app.auth_directory_users(organization_id, id, user_id) ON DELETE RESTRICT;


--
-- Name: auth_directory_memberships auth_directory_membership_member_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_memberships
    ADD CONSTRAINT auth_directory_membership_member_fk FOREIGN KEY (workspace_id, user_id) REFERENCES app.workspace_memberships(workspace_id, user_id) ON DELETE CASCADE;


--
-- Name: auth_directory_memberships auth_directory_membership_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_memberships
    ADD CONSTRAINT auth_directory_membership_workspace_fk FOREIGN KEY (organization_id, workspace_id) REFERENCES app.auth_organization_workspaces(organization_id, workspace_id) ON DELETE RESTRICT;


--
-- Name: auth_directory_users auth_directory_user_account_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_users
    ADD CONSTRAINT auth_directory_user_account_fk FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: auth_directory_users auth_directory_user_org_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_directory_users
    ADD CONSTRAINT auth_directory_user_org_fk FOREIGN KEY (organization_id) REFERENCES app.auth_organizations(id) ON DELETE CASCADE;


--
-- Name: auth_domains auth_domain_organization_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_domains
    ADD CONSTRAINT auth_domain_organization_fk FOREIGN KEY (organization_id) REFERENCES app.auth_organizations(id) ON DELETE CASCADE;


--
-- Name: auth_email_proofs auth_email_proofs_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_email_proofs
    ADD CONSTRAINT auth_email_proofs_user_id_fkey FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE;


--
-- Name: auth_federation_attempts auth_federation_attempt_domain_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_federation_attempts
    ADD CONSTRAINT auth_federation_attempt_domain_fk FOREIGN KEY (organization_id, domain_id) REFERENCES app.auth_domains(organization_id, id) ON DELETE CASCADE;


--
-- Name: auth_federation_attempts auth_federation_attempt_provider_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_federation_attempts
    ADD CONSTRAINT auth_federation_attempt_provider_fk FOREIGN KEY (organization_id, provider_id) REFERENCES app.auth_providers(organization_id, id) ON DELETE CASCADE;


--
-- Name: auth_method_link_attempts auth_method_link_attempts_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_method_link_attempts
    ADD CONSTRAINT auth_method_link_attempts_user_id_fkey FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE;


--
-- Name: auth_organizations auth_organization_control_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_organizations
    ADD CONSTRAINT auth_organization_control_fk FOREIGN KEY (control_workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;


--
-- Name: auth_organization_workspaces auth_organization_workspace_org_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_organization_workspaces
    ADD CONSTRAINT auth_organization_workspace_org_fk FOREIGN KEY (organization_id) REFERENCES app.auth_organizations(id) ON DELETE CASCADE;


--
-- Name: auth_organization_workspaces auth_organization_workspace_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_organization_workspaces
    ADD CONSTRAINT auth_organization_workspace_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;


--
-- Name: auth_provider_checks auth_provider_check_domain_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_provider_checks
    ADD CONSTRAINT auth_provider_check_domain_fk FOREIGN KEY (organization_id, domain_id) REFERENCES app.auth_domains(organization_id, id) ON DELETE CASCADE;


--
-- Name: auth_provider_checks auth_provider_check_provider_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_provider_checks
    ADD CONSTRAINT auth_provider_check_provider_fk FOREIGN KEY (organization_id, provider_id) REFERENCES app.auth_providers(organization_id, id) ON DELETE CASCADE;


--
-- Name: auth_providers auth_provider_organization_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_providers
    ADD CONSTRAINT auth_provider_organization_fk FOREIGN KEY (organization_id) REFERENCES app.auth_organizations(id) ON DELETE CASCADE;


--
-- Name: auth_provisioning_credentials auth_provisioning_credential_creator_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_provisioning_credentials
    ADD CONSTRAINT auth_provisioning_credential_creator_fk FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE SET NULL;


--
-- Name: auth_provisioning_credentials auth_provisioning_credential_org_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_provisioning_credentials
    ADD CONSTRAINT auth_provisioning_credential_org_fk FOREIGN KEY (organization_id) REFERENCES app.auth_organizations(id) ON DELETE CASCADE;


--
-- Name: auth_sessions auth_session_federation_provider_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_sessions
    ADD CONSTRAINT auth_session_federation_provider_fk FOREIGN KEY (federation_provider_id) REFERENCES app.auth_providers(id) ON DELETE CASCADE;


--
-- Name: auth_sessions auth_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE;


--
-- Name: auth_two_factors auth_two_factors_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.auth_two_factors
    ADD CONSTRAINT auth_two_factors_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE;


--
-- Name: workflow_comments comment_author_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_comments
    ADD CONSTRAINT comment_author_fk FOREIGN KEY (author_id) REFERENCES app.users(id) ON DELETE SET NULL;


--
-- Name: workflow_comment_mentions comment_mention_comment_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_comment_mentions
    ADD CONSTRAINT comment_mention_comment_fk FOREIGN KEY (workspace_id, comment_id) REFERENCES app.workflow_comments(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_comment_mentions comment_mention_member_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_comment_mentions
    ADD CONSTRAINT comment_mention_member_fk FOREIGN KEY (workspace_id, user_id) REFERENCES app.workspace_memberships(workspace_id, user_id) ON DELETE CASCADE;


--
-- Name: workflow_comment_threads comment_thread_author_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_comment_threads
    ADD CONSTRAINT comment_thread_author_fk FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE SET NULL;


--
-- Name: workflow_comments comment_thread_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_comments
    ADD CONSTRAINT comment_thread_fk FOREIGN KEY (workspace_id, thread_id) REFERENCES app.workflow_comment_threads(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_comment_threads comment_thread_workflow_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_comment_threads
    ADD CONSTRAINT comment_thread_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: connection_events connection_events_connection_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_events
    ADD CONSTRAINT connection_events_connection_fk FOREIGN KEY (workspace_id, connection_id) REFERENCES app.connections(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: connection_health_observations connection_health_observations_dispatch_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_health_observations
    ADD CONSTRAINT connection_health_observations_dispatch_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES app.node_attempt_connection_dispatches(workspace_id, attempt_id) ON DELETE CASCADE;


--
-- Name: connection_oauth2_authorizations connection_oauth2_authorizations_client_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_oauth2_authorizations
    ADD CONSTRAINT connection_oauth2_authorizations_client_fk FOREIGN KEY (workspace_id, connection_id, secret_version_id) REFERENCES app.connection_oauth2_clients(workspace_id, connection_id, secret_version_id) ON DELETE CASCADE;


--
-- Name: connection_oauth2_authorizations connection_oauth2_authorizations_member_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_oauth2_authorizations
    ADD CONSTRAINT connection_oauth2_authorizations_member_fk FOREIGN KEY (workspace_id, started_by) REFERENCES app.workspace_memberships(workspace_id, user_id) ON DELETE CASCADE;


--
-- Name: connection_oauth2_clients connection_oauth2_clients_secret_version_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_oauth2_clients
    ADD CONSTRAINT connection_oauth2_clients_secret_version_fk FOREIGN KEY (workspace_id, connection_id, secret_version_id) REFERENCES app.connection_secret_versions(workspace_id, connection_id, id) ON DELETE CASCADE;


--
-- Name: connection_oauth2_tokens connection_oauth2_tokens_client_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_oauth2_tokens
    ADD CONSTRAINT connection_oauth2_tokens_client_fk FOREIGN KEY (workspace_id, connection_id, secret_version_id) REFERENCES app.connection_oauth2_clients(workspace_id, connection_id, secret_version_id) ON DELETE CASCADE;


--
-- Name: connection_secret_versions connection_secret_versions_connection_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_secret_versions
    ADD CONSTRAINT connection_secret_versions_connection_fk FOREIGN KEY (workspace_id, connection_id) REFERENCES app.connections(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: connection_secret_versions connection_secret_versions_created_by_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_secret_versions
    ADD CONSTRAINT connection_secret_versions_created_by_fk FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: connection_shares connection_shares_connection_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_shares
    ADD CONSTRAINT connection_shares_connection_fk FOREIGN KEY (workspace_id, connection_id) REFERENCES app.connections(workspace_id, id) ON DELETE CASCADE;


--
-- Name: connection_shares connection_shares_member_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connection_shares
    ADD CONSTRAINT connection_shares_member_fk FOREIGN KEY (workspace_id, user_id) REFERENCES app.workspace_memberships(workspace_id, user_id) ON DELETE CASCADE;


--
-- Name: connections connections_created_by_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connections
    ADD CONSTRAINT connections_created_by_fk FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: connections connections_current_secret_same_connection_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connections
    ADD CONSTRAINT connections_current_secret_same_connection_fk FOREIGN KEY (workspace_id, id, current_secret_version_id) REFERENCES app.connection_secret_versions(workspace_id, connection_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: connections connections_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.connections
    ADD CONSTRAINT connections_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;


--
-- Name: data_table_write_receipts data_table_write_receipts_workspace_id_preview_run_id_preview_r; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.data_table_write_receipts
    ADD CONSTRAINT data_table_write_receipts_workspace_id_preview_run_id_preview_r FOREIGN KEY (workspace_id, preview_run_id) REFERENCES app.preview_runs(workspace_id, id) ON DELETE CASCADE;


--
-- Name: data_table_write_receipts data_table_write_receipts_workspace_id_run_id_workflow_runs_wor; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.data_table_write_receipts
    ADD CONSTRAINT data_table_write_receipts_workspace_id_run_id_workflow_runs_wor FOREIGN KEY (workspace_id, run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;


--
-- Name: failure_notification_destination_versions failure_notification_destination_versions_creator_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.failure_notification_destination_versions
    ADD CONSTRAINT failure_notification_destination_versions_creator_fk FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: failure_notification_destination_versions failure_notification_destination_versions_destination_kind_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.failure_notification_destination_versions
    ADD CONSTRAINT failure_notification_destination_versions_destination_kind_fk FOREIGN KEY (workspace_id, destination_id, kind) REFERENCES app.failure_notification_destinations(workspace_id, id, kind) ON DELETE RESTRICT;


--
-- Name: failure_notification_destinations failure_notification_destinations_creator_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.failure_notification_destinations
    ADD CONSTRAINT failure_notification_destinations_creator_fk FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: failure_notification_destinations failure_notification_destinations_current_version_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.failure_notification_destinations
    ADD CONSTRAINT failure_notification_destinations_current_version_fk FOREIGN KEY (workspace_id, id, current_config_version) REFERENCES app.failure_notification_destination_versions(workspace_id, destination_id, version) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: failure_notification_destinations failure_notification_destinations_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.failure_notification_destinations
    ADD CONSTRAINT failure_notification_destinations_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;


--
-- Name: form_uploads form_uploads_artifact_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.form_uploads
    ADD CONSTRAINT form_uploads_artifact_fk FOREIGN KEY (workspace_id, artifact_id) REFERENCES app.artifacts(workspace_id, id) ON DELETE CASCADE;


--
-- Name: node_attempt_connection_dispatches node_attempt_connection_dispatches_attempt_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.node_attempt_connection_dispatches
    ADD CONSTRAINT node_attempt_connection_dispatches_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES app.node_attempts(workspace_id, id) ON DELETE CASCADE;


--
-- Name: node_attempts node_attempts_node_run_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.node_attempts
    ADD CONSTRAINT node_attempts_node_run_workspace_fk FOREIGN KEY (workspace_id, node_run_id) REFERENCES app.node_runs(workspace_id, id) ON DELETE CASCADE;


--
-- Name: node_runs node_runs_current_attempt_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.node_runs
    ADD CONSTRAINT node_runs_current_attempt_workspace_fk FOREIGN KEY (workspace_id, current_attempt_id) REFERENCES app.node_attempts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: node_runs node_runs_run_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.node_runs
    ADD CONSTRAINT node_runs_run_workspace_fk FOREIGN KEY (workspace_id, workflow_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;


--
-- Name: notice_mail_batches notice_mail_batches_delivery_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.notice_mail_batches
    ADD CONSTRAINT notice_mail_batches_delivery_fk FOREIGN KEY (id) REFERENCES app.system_mail_deliveries(id) ON DELETE CASCADE;


--
-- Name: notice_mail_batches notice_mail_batches_member_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.notice_mail_batches
    ADD CONSTRAINT notice_mail_batches_member_fk FOREIGN KEY (workspace_id, user_id) REFERENCES app.workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT;


--
-- Name: notice_mail_items notice_mail_items_batch_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.notice_mail_items
    ADD CONSTRAINT notice_mail_items_batch_fk FOREIGN KEY (workspace_id, batch_id) REFERENCES app.notice_mail_batches(workspace_id, id) ON DELETE CASCADE;


--
-- Name: notice_mail_items notice_mail_items_thread_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.notice_mail_items
    ADD CONSTRAINT notice_mail_items_thread_fk FOREIGN KEY (workspace_id, thread_id) REFERENCES app.workspace_inbox_threads(workspace_id, id) ON DELETE CASCADE;


--
-- Name: notice_preferences notice_preferences_member_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.notice_preferences
    ADD CONSTRAINT notice_preferences_member_fk FOREIGN KEY (workspace_id, user_id) REFERENCES app.workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT;


--
-- Name: notice_subscriptions notice_subscriptions_connection_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.notice_subscriptions
    ADD CONSTRAINT notice_subscriptions_connection_fk FOREIGN KEY (workspace_id, connection_id) REFERENCES app.connections(workspace_id, id) ON DELETE CASCADE;


--
-- Name: notice_subscriptions notice_subscriptions_member_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.notice_subscriptions
    ADD CONSTRAINT notice_subscriptions_member_fk FOREIGN KEY (workspace_id, user_id) REFERENCES app.workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT;


--
-- Name: notice_subscriptions notice_subscriptions_workflow_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.notice_subscriptions
    ADD CONSTRAINT notice_subscriptions_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: notice_workspace_settings notice_workspace_settings_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.notice_workspace_settings
    ADD CONSTRAINT notice_workspace_settings_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;


--
-- Name: operator_commands operator_commands_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.operator_commands
    ADD CONSTRAINT operator_commands_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);


--
-- Name: operator_run_replay_requests operator_run_replay_requests_command_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.operator_run_replay_requests
    ADD CONSTRAINT operator_run_replay_requests_command_id_fkey FOREIGN KEY (command_id) REFERENCES app.operator_commands(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: operator_run_replay_requests operator_run_replay_result_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.operator_run_replay_requests
    ADD CONSTRAINT operator_run_replay_result_fk FOREIGN KEY (workspace_id, result_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;


--
-- Name: operator_run_replay_requests operator_run_replay_source_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.operator_run_replay_requests
    ADD CONSTRAINT operator_run_replay_source_fk FOREIGN KEY (workspace_id, source_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;


--
-- Name: operator_run_replay_requests operator_run_replay_version_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.operator_run_replay_requests
    ADD CONSTRAINT operator_run_replay_version_fk FOREIGN KEY (workspace_id, workflow_version_id) REFERENCES app.workflow_versions(workspace_id, id) ON DELETE CASCADE;


--
-- Name: operator_unknown_outcome_evidence operator_unknown_evidence_attempt_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.operator_unknown_outcome_evidence
    ADD CONSTRAINT operator_unknown_evidence_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES app.node_attempts(workspace_id, id) ON DELETE CASCADE;


--
-- Name: pending_run_tasks pending_run_tasks_decider_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.pending_run_tasks
    ADD CONSTRAINT pending_run_tasks_decider_fk FOREIGN KEY (decided_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: pending_run_tasks pending_run_tasks_node_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.pending_run_tasks
    ADD CONSTRAINT pending_run_tasks_node_fk FOREIGN KEY (workspace_id, node_run_id) REFERENCES app.node_runs(workspace_id, id) ON DELETE CASCADE;


--
-- Name: pending_run_tasks pending_run_tasks_run_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.pending_run_tasks
    ADD CONSTRAINT pending_run_tasks_run_fk FOREIGN KEY (workspace_id, run_id, workflow_version_id) REFERENCES app.workflow_runs(workspace_id, id, workflow_version_id) ON DELETE CASCADE;


--
-- Name: workflow_presence_leases presence_member_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_presence_leases
    ADD CONSTRAINT presence_member_fk FOREIGN KEY (workspace_id, user_id) REFERENCES app.workspace_memberships(workspace_id, user_id) ON DELETE CASCADE;


--
-- Name: workflow_presence_leases presence_workflow_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_presence_leases
    ADD CONSTRAINT presence_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: preview_attempts preview_attempts_run_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.preview_attempts
    ADD CONSTRAINT preview_attempts_run_fk FOREIGN KEY (workspace_id, preview_run_id) REFERENCES app.preview_runs(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: preview_runs preview_runs_actor_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.preview_runs
    ADD CONSTRAINT preview_runs_actor_fk FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: preview_runs preview_runs_prior_preview_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.preview_runs
    ADD CONSTRAINT preview_runs_prior_preview_fk FOREIGN KEY (workspace_id, workflow_id, prior_preview_run_id) REFERENCES app.preview_runs(workspace_id, workflow_id, id) ON DELETE RESTRICT;


--
-- Name: preview_runs preview_runs_variable_set_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.preview_runs
    ADD CONSTRAINT preview_runs_variable_set_fk FOREIGN KEY (workspace_id, variable_set_revision) REFERENCES app.workspace_variable_set_revisions(workspace_id, revision);


--
-- Name: preview_runs preview_runs_workflow_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.preview_runs
    ADD CONSTRAINT preview_runs_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: workflow_promotion_origins promotion_origin_target_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_promotion_origins
    ADD CONSTRAINT promotion_origin_target_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workspace_promotion_targets promotion_target_actor_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_promotion_targets
    ADD CONSTRAINT promotion_target_actor_fk FOREIGN KEY (updated_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: workspace_promotion_targets promotion_target_destination_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_promotion_targets
    ADD CONSTRAINT promotion_target_destination_fk FOREIGN KEY (target_workspace_id) REFERENCES app.workspaces(id) ON DELETE SET NULL;


--
-- Name: workspace_promotion_targets promotion_target_source_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_promotion_targets
    ADD CONSTRAINT promotion_target_source_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;


--
-- Name: workflow_publication_requests publication_requests_decider_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_publication_requests
    ADD CONSTRAINT publication_requests_decider_fk FOREIGN KEY (decided_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: workflow_publication_requests publication_requests_requester_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_publication_requests
    ADD CONSTRAINT publication_requests_requester_fk FOREIGN KEY (requested_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: workflow_publication_requests publication_requests_version_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_publication_requests
    ADD CONSTRAINT publication_requests_version_fk FOREIGN KEY (workspace_id, workflow_id, published_version_id) REFERENCES app.workflow_versions(workspace_id, workflow_id, id) ON DELETE RESTRICT;


--
-- Name: workflow_publication_requests publication_requests_workflow_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_publication_requests
    ADD CONSTRAINT publication_requests_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: run_checkpoints run_checkpoints_run_version_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.run_checkpoints
    ADD CONSTRAINT run_checkpoints_run_version_workspace_fk FOREIGN KEY (workspace_id, workflow_run_id, workflow_version_id) REFERENCES app.workflow_runs(workspace_id, id, workflow_version_id) ON DELETE CASCADE;


--
-- Name: run_checkpoints run_checkpoints_run_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.run_checkpoints
    ADD CONSTRAINT run_checkpoints_run_workspace_fk FOREIGN KEY (workspace_id, workflow_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;


--
-- Name: run_error_workflow_intents run_error_workflow_intents_source_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.run_error_workflow_intents
    ADD CONSTRAINT run_error_workflow_intents_source_fk FOREIGN KEY (workspace_id, source_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;


--
-- Name: run_error_workflow_intents run_error_workflow_intents_version_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.run_error_workflow_intents
    ADD CONSTRAINT run_error_workflow_intents_version_fk FOREIGN KEY (workspace_id, target_workflow_id, target_version_id) REFERENCES app.workflow_versions(workspace_id, workflow_id, id) ON DELETE RESTRICT;


--
-- Name: run_events run_events_run_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.run_events
    ADD CONSTRAINT run_events_run_workspace_fk FOREIGN KEY (workspace_id, workflow_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;


--
-- Name: run_failure_notification_audit_facts run_failure_notification_audit_intent_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.run_failure_notification_audit_facts
    ADD CONSTRAINT run_failure_notification_audit_intent_workspace_fk FOREIGN KEY (workspace_id, notification_intent_id) REFERENCES app.run_failure_notification_intents(workspace_id, id) ON DELETE CASCADE;


--
-- Name: run_failure_notification_intents run_failure_notification_intents_destination_version_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.run_failure_notification_intents
    ADD CONSTRAINT run_failure_notification_intents_destination_version_fk FOREIGN KEY (workspace_id, destination_id, destination_config_version) REFERENCES app.failure_notification_destination_versions(workspace_id, destination_id, version) ON DELETE RESTRICT;


--
-- Name: run_failure_notification_intents run_failure_notification_intents_run_pin_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.run_failure_notification_intents
    ADD CONSTRAINT run_failure_notification_intents_run_pin_fk FOREIGN KEY (workspace_id, workflow_run_id, destination_id, destination_config_version, side_effect_class, connection_secret_version_id) REFERENCES app.workflow_runs(workspace_id, id, failure_notification_destination_id, failure_notification_destination_config_version, failure_notification_side_effect_class, failure_notification_connection_secret_version_id) ON DELETE CASCADE;


--
-- Name: run_failure_notification_intents run_failure_notification_intents_run_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.run_failure_notification_intents
    ADD CONSTRAINT run_failure_notification_intents_run_workspace_fk FOREIGN KEY (workspace_id, workflow_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;


--
-- Name: trigger_coordinated_events trigger_coordinated_events_workspace_id_endpoint_id_webhook_tri; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_coordinated_events
    ADD CONSTRAINT trigger_coordinated_events_workspace_id_endpoint_id_webhook_tri FOREIGN KEY (workspace_id, endpoint_id) REFERENCES app.webhook_trigger_endpoints(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: trigger_coordinated_events trigger_coordinated_events_workspace_id_key_id_trigger_event_wi; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_coordinated_events
    ADD CONSTRAINT trigger_coordinated_events_workspace_id_key_id_trigger_event_wi FOREIGN KEY (workspace_id, key_id) REFERENCES app.trigger_event_windows(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: trigger_coordinated_events trigger_coordinated_events_workspace_id_run_id_workflow_runs_wo; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_coordinated_events
    ADD CONSTRAINT trigger_coordinated_events_workspace_id_run_id_workflow_runs_wo FOREIGN KEY (workspace_id, run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: trigger_coordinated_events trigger_coordinated_events_workspace_id_workflow_id_workflows_w; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_coordinated_events
    ADD CONSTRAINT trigger_coordinated_events_workspace_id_workflow_id_workflows_w FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: trigger_coordinated_events trigger_coordinated_events_workspace_id_workflow_version_id_wor; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_coordinated_events
    ADD CONSTRAINT trigger_coordinated_events_workspace_id_workflow_version_id_wor FOREIGN KEY (workspace_id, workflow_version_id) REFERENCES app.workflow_versions(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: trigger_coordinated_events trigger_coordinated_events_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_coordinated_events
    ADD CONSTRAINT trigger_coordinated_events_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;


--
-- Name: trigger_event_windows trigger_event_windows_workspace_id_workflow_id_workflows_worksp; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_event_windows
    ADD CONSTRAINT trigger_event_windows_workspace_id_workflow_id_workflows_worksp FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: trigger_event_windows trigger_event_windows_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_event_windows
    ADD CONSTRAINT trigger_event_windows_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;


--
-- Name: trigger_schedule_occurrences trigger_schedule_occurrences_run_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_schedule_occurrences
    ADD CONSTRAINT trigger_schedule_occurrences_run_fk FOREIGN KEY (workspace_id, workflow_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: trigger_schedule_occurrences trigger_schedule_occurrences_schedule_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_schedule_occurrences
    ADD CONSTRAINT trigger_schedule_occurrences_schedule_fk FOREIGN KEY (workspace_id, trigger_id) REFERENCES app.trigger_schedules(workspace_id, trigger_id) ON DELETE RESTRICT;


--
-- Name: trigger_schedules trigger_schedules_trigger_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.trigger_schedules
    ADD CONSTRAINT trigger_schedules_trigger_fk FOREIGN KEY (workspace_id, trigger_id) REFERENCES app.workflow_triggers(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: usage_events usage_events_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.usage_events
    ADD CONSTRAINT usage_events_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;


--
-- Name: user_profile_command_receipts user_profile_command_receipts_actor_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.user_profile_command_receipts
    ADD CONSTRAINT user_profile_command_receipts_actor_fk FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE CASCADE;


--
-- Name: workflow_version_promotions version_promotion_target_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_version_promotions
    ADD CONSTRAINT version_promotion_target_fk FOREIGN KEY (workspace_id, workflow_id, version_id) REFERENCES app.workflow_versions(workspace_id, workflow_id, id) ON DELETE CASCADE;


--
-- Name: webhook_endpoint_ingress_limits webhook_endpoint_ingress_limits_endpoint_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_endpoint_ingress_limits
    ADD CONSTRAINT webhook_endpoint_ingress_limits_endpoint_fk FOREIGN KEY (workspace_id, endpoint_id) REFERENCES app.webhook_trigger_endpoints(workspace_id, id) ON DELETE CASCADE;


--
-- Name: webhook_run_responses webhook_run_responses_run_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_run_responses
    ADD CONSTRAINT webhook_run_responses_run_fk FOREIGN KEY (workspace_id, run_id) REFERENCES app.workflow_runs(workspace_id, id);


--
-- Name: webhook_test_events webhook_test_events_workflow_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_test_events
    ADD CONSTRAINT webhook_test_events_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: webhook_trigger_deliveries webhook_trigger_deliveries_endpoint_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_deliveries
    ADD CONSTRAINT webhook_trigger_deliveries_endpoint_fk FOREIGN KEY (workspace_id, endpoint_id) REFERENCES app.webhook_trigger_endpoints(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: webhook_trigger_deliveries webhook_trigger_deliveries_run_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_deliveries
    ADD CONSTRAINT webhook_trigger_deliveries_run_fk FOREIGN KEY (workspace_id, workflow_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: webhook_trigger_deliveries webhook_trigger_deliveries_workspace_id_coordination_event_id_t; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_deliveries
    ADD CONSTRAINT webhook_trigger_deliveries_workspace_id_coordination_event_id_t FOREIGN KEY (workspace_id, coordination_event_id) REFERENCES app.trigger_coordinated_events(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: webhook_trigger_endpoints webhook_trigger_endpoints_current_secret_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_endpoints
    ADD CONSTRAINT webhook_trigger_endpoints_current_secret_fk FOREIGN KEY (workspace_id, workflow_id, node_id, current_secret_version_id) REFERENCES app.webhook_trigger_secret_versions(workspace_id, workflow_id, node_id, id) ON DELETE RESTRICT;


--
-- Name: webhook_trigger_endpoints webhook_trigger_endpoints_previous_secret_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_endpoints
    ADD CONSTRAINT webhook_trigger_endpoints_previous_secret_fk FOREIGN KEY (workspace_id, workflow_id, node_id, previous_secret_version_id) REFERENCES app.webhook_trigger_secret_versions(workspace_id, workflow_id, node_id, id) ON DELETE RESTRICT;


--
-- Name: webhook_trigger_endpoints webhook_trigger_endpoints_workflow_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_endpoints
    ADD CONSTRAINT webhook_trigger_endpoints_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: webhook_trigger_replay_records webhook_trigger_replay_records_delivery_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_replay_records
    ADD CONSTRAINT webhook_trigger_replay_records_delivery_fk FOREIGN KEY (workspace_id, delivery_id) REFERENCES app.webhook_trigger_deliveries(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: webhook_trigger_replay_records webhook_trigger_replay_records_endpoint_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_replay_records
    ADD CONSTRAINT webhook_trigger_replay_records_endpoint_fk FOREIGN KEY (workspace_id, endpoint_id) REFERENCES app.webhook_trigger_endpoints(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: webhook_trigger_replay_records webhook_trigger_replay_records_run_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_replay_records
    ADD CONSTRAINT webhook_trigger_replay_records_run_fk FOREIGN KEY (workspace_id, workflow_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: webhook_trigger_replay_records webhook_trigger_replay_records_workspace_id_coordination_event_; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_replay_records
    ADD CONSTRAINT webhook_trigger_replay_records_workspace_id_coordination_event_ FOREIGN KEY (workspace_id, coordination_event_id) REFERENCES app.trigger_coordinated_events(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: webhook_trigger_secret_versions webhook_trigger_secret_versions_creator_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_secret_versions
    ADD CONSTRAINT webhook_trigger_secret_versions_creator_fk FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: webhook_trigger_secret_versions webhook_trigger_secret_versions_trigger_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.webhook_trigger_secret_versions
    ADD CONSTRAINT webhook_trigger_secret_versions_trigger_fk FOREIGN KEY (workspace_id, trigger_id, workflow_id, node_id) REFERENCES app.workflow_triggers(workspace_id, id, workflow_id, node_id) ON DELETE RESTRICT;


--
-- Name: workflow_calls workflow_calls_live_child_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_calls
    ADD CONSTRAINT workflow_calls_live_child_fk FOREIGN KEY (workspace_id, live_child_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: workflow_calls workflow_calls_parent_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_calls
    ADD CONSTRAINT workflow_calls_parent_fk FOREIGN KEY (workspace_id, parent_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_calls workflow_calls_target_version_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_calls
    ADD CONSTRAINT workflow_calls_target_version_fk FOREIGN KEY (workspace_id, target_workflow_id, target_version_id) REFERENCES app.workflow_versions(workspace_id, workflow_id, id) ON DELETE RESTRICT;


--
-- Name: workflow_concurrency_policies workflow_concurrency_policies_workspace_id_workflow_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_concurrency_policies
    ADD CONSTRAINT workflow_concurrency_policies_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_drafts workflow_drafts_updated_by_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_drafts
    ADD CONSTRAINT workflow_drafts_updated_by_fk FOREIGN KEY (updated_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: workflow_drafts workflow_drafts_workflow_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_drafts
    ADD CONSTRAINT workflow_drafts_workflow_workspace_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_error_policies workflow_error_policies_workspace_id_target_workflow_id_workflo; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_error_policies
    ADD CONSTRAINT workflow_error_policies_workspace_id_target_workflow_id_workflo FOREIGN KEY (workspace_id, target_workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: workflow_error_policies workflow_error_policies_workspace_id_workflow_id_workflows_work; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_error_policies
    ADD CONSTRAINT workflow_error_policies_workspace_id_workflow_id_workflows_work FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_failure_notification_policies workflow_failure_notification_policies_destination_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_failure_notification_policies
    ADD CONSTRAINT workflow_failure_notification_policies_destination_fk FOREIGN KEY (workspace_id, destination_id) REFERENCES app.failure_notification_destinations(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: workflow_failure_notification_policies workflow_failure_notification_policies_updater_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_failure_notification_policies
    ADD CONSTRAINT workflow_failure_notification_policies_updater_fk FOREIGN KEY (updated_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: workflow_failure_notification_policies workflow_failure_notification_policies_workflow_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_failure_notification_policies
    ADD CONSTRAINT workflow_failure_notification_policies_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_failure_streaks workflow_failure_streaks_workflow_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_failure_streaks
    ADD CONSTRAINT workflow_failure_streaks_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_favorites workflow_favorites_workspace_id_workflow_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_favorites
    ADD CONSTRAINT workflow_favorites_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id);


--
-- Name: workflow_folder_grants workflow_folder_grants_folder_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_folder_grants
    ADD CONSTRAINT workflow_folder_grants_folder_fk FOREIGN KEY (workspace_id, folder_id) REFERENCES app.workflow_folders(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_folder_grants workflow_folder_grants_group_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_folder_grants
    ADD CONSTRAINT workflow_folder_grants_group_fk FOREIGN KEY (organization_id, group_id) REFERENCES app.auth_directory_groups(organization_id, id) ON DELETE CASCADE;


--
-- Name: workflow_folder_grants workflow_folder_grants_link_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_folder_grants
    ADD CONSTRAINT workflow_folder_grants_link_fk FOREIGN KEY (organization_id, workspace_id) REFERENCES app.auth_organization_workspaces(organization_id, workspace_id) ON DELETE CASCADE;


--
-- Name: workflow_folder_grants workflow_folder_grants_member_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_folder_grants
    ADD CONSTRAINT workflow_folder_grants_member_fk FOREIGN KEY (workspace_id, user_id) REFERENCES app.workspace_memberships(workspace_id, user_id) ON DELETE CASCADE;


--
-- Name: workflow_folders workflow_folders_workspace_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_folders
    ADD CONSTRAINT workflow_folders_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);


--
-- Name: workflow_folders workflow_folders_workspace_id_parent_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_folders
    ADD CONSTRAINT workflow_folders_workspace_id_parent_id_fkey FOREIGN KEY (workspace_id, parent_id) REFERENCES app.workflow_folders(workspace_id, id);


--
-- Name: workflow_forms workflow_forms_workspace_id_workflow_id_workflows_workspace_id_; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_forms
    ADD CONSTRAINT workflow_forms_workspace_id_workflow_id_workflows_workspace_id_ FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_input_case_payloads workflow_input_case_payloads_workspace_id_case_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_input_case_payloads
    ADD CONSTRAINT workflow_input_case_payloads_workspace_id_case_id_fkey FOREIGN KEY (workspace_id, case_id) REFERENCES app.workflow_input_cases(workspace_id, id);


--
-- Name: workflow_input_cases workflow_input_cases_workspace_id_workflow_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_input_cases
    ADD CONSTRAINT workflow_input_cases_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id);


--
-- Name: workflow_input_cases workflow_input_cases_workspace_id_workflow_id_workflow_ver_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_input_cases
    ADD CONSTRAINT workflow_input_cases_workspace_id_workflow_id_workflow_ver_fkey FOREIGN KEY (workspace_id, workflow_id, workflow_version_id) REFERENCES app.workflow_versions(workspace_id, workflow_id, id);


--
-- Name: workflow_integration_usage workflow_integration_usage_connection_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_integration_usage
    ADD CONSTRAINT workflow_integration_usage_connection_fk FOREIGN KEY (workspace_id, connection_id) REFERENCES app.connections(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: workflow_integration_usage workflow_integration_usage_version_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_integration_usage
    ADD CONSTRAINT workflow_integration_usage_version_fk FOREIGN KEY (workspace_id, workflow_version_id) REFERENCES app.workflow_versions(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_manual_start_rejections workflow_manual_start_rejections_workspace_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_manual_start_rejections
    ADD CONSTRAINT workflow_manual_start_rejections_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);


--
-- Name: workflow_manual_start_rejections workflow_manual_start_rejections_workspace_id_workflow_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_manual_start_rejections
    ADD CONSTRAINT workflow_manual_start_rejections_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id);


--
-- Name: workflow_organization_state workflow_organization_state_folder_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_organization_state
    ADD CONSTRAINT workflow_organization_state_folder_fk FOREIGN KEY (workspace_id, folder_id) REFERENCES app.workflow_folders(workspace_id, id);


--
-- Name: workflow_organization_state workflow_organization_state_workspace_id_workflow_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_organization_state
    ADD CONSTRAINT workflow_organization_state_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id);


--
-- Name: workflow_run_active_admissions workflow_run_active_admissions_call_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_run_active_admissions
    ADD CONSTRAINT workflow_run_active_admissions_call_fk FOREIGN KEY (workspace_id, borrowed_call_id) REFERENCES app.workflow_calls(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: workflow_run_active_admissions workflow_run_active_admissions_outbox_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_run_active_admissions
    ADD CONSTRAINT workflow_run_active_admissions_outbox_fk FOREIGN KEY (outbox_event_id) REFERENCES app.outbox_events(id) ON DELETE CASCADE;


--
-- Name: workflow_run_active_admissions workflow_run_active_admissions_run_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_run_active_admissions
    ADD CONSTRAINT workflow_run_active_admissions_run_fk FOREIGN KEY (workflow_run_id) REFERENCES app.workflow_runs(id) ON DELETE CASCADE;


--
-- Name: workflow_run_active_admissions workflow_run_active_admissions_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_run_active_admissions
    ADD CONSTRAINT workflow_run_active_admissions_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workflow_run_values workflow_run_values_preview_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_run_values
    ADD CONSTRAINT workflow_run_values_preview_fk FOREIGN KEY (workspace_id, preview_run_id) REFERENCES app.preview_runs(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_run_values workflow_run_values_run_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_run_values
    ADD CONSTRAINT workflow_run_values_run_fk FOREIGN KEY (workspace_id, workflow_run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_runs workflow_runs_execution_entitlement_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_execution_entitlement_fk FOREIGN KEY (workspace_id, execution_entitlement_version) REFERENCES app.workspace_execution_entitlement_versions(workspace_id, version) ON DELETE RESTRICT;


--
-- Name: workflow_runs workflow_runs_failure_notification_destination_version_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_failure_notification_destination_version_fk FOREIGN KEY (workspace_id, failure_notification_destination_id, failure_notification_destination_config_version) REFERENCES app.failure_notification_destination_versions(workspace_id, destination_id, version) ON DELETE RESTRICT;


--
-- Name: workflow_runs workflow_runs_replay_source_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_replay_source_fk FOREIGN KEY (workspace_id, replay_source_run_id) REFERENCES app.workflow_runs(workspace_id, id);


--
-- Name: workflow_runs workflow_runs_starter_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_starter_fk FOREIGN KEY (started_by) REFERENCES app.users(id) ON DELETE SET NULL;


--
-- Name: workflow_runs workflow_runs_variable_set_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_runs
    ADD CONSTRAINT workflow_runs_variable_set_fk FOREIGN KEY (workspace_id, variable_set_revision) REFERENCES app.workspace_variable_set_revisions(workspace_id, revision);


--
-- Name: workflow_step_samples workflow_step_samples_workflow_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_step_samples
    ADD CONSTRAINT workflow_step_samples_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id);


--
-- Name: workflow_tag_assignments workflow_tag_assignments_workspace_id_tag_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_tag_assignments
    ADD CONSTRAINT workflow_tag_assignments_workspace_id_tag_id_fkey FOREIGN KEY (workspace_id, tag_id) REFERENCES app.workflow_tags(workspace_id, id);


--
-- Name: workflow_tag_assignments workflow_tag_assignments_workspace_id_workflow_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_tag_assignments
    ADD CONSTRAINT workflow_tag_assignments_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id);


--
-- Name: workflow_tags workflow_tags_workspace_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_tags
    ADD CONSTRAINT workflow_tags_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id);


--
-- Name: workflow_template_origins workflow_template_origins_workspace_id_workflow_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_template_origins
    ADD CONSTRAINT workflow_template_origins_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_test_snapshots workflow_test_snapshots_workflow_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_test_snapshots
    ADD CONSTRAINT workflow_test_snapshots_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id);


--
-- Name: workflow_test_suite_cases workflow_test_suite_cases_suite_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_test_suite_cases
    ADD CONSTRAINT workflow_test_suite_cases_suite_fk FOREIGN KEY (workspace_id, suite_id) REFERENCES app.workflow_test_suites(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_test_suites workflow_test_suites_source_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_test_suites
    ADD CONSTRAINT workflow_test_suites_source_fk FOREIGN KEY (workspace_id, snapshot_id) REFERENCES app.workflow_test_snapshots(workspace_id, id);


--
-- Name: workflow_test_suites workflow_test_suites_variables_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_test_suites
    ADD CONSTRAINT workflow_test_suites_variables_fk FOREIGN KEY (workspace_id, variable_set_revision) REFERENCES app.workspace_variable_set_revisions(workspace_id, revision);


--
-- Name: workflow_trigger_failures workflow_trigger_failures_workflow_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_trigger_failures
    ADD CONSTRAINT workflow_trigger_failures_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_trigger_outcomes workflow_trigger_outcomes_run_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_trigger_outcomes
    ADD CONSTRAINT workflow_trigger_outcomes_run_fk FOREIGN KEY (workspace_id, run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_trigger_outcomes workflow_trigger_outcomes_workflow_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_trigger_outcomes
    ADD CONSTRAINT workflow_trigger_outcomes_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_trigger_pause_periods workflow_trigger_pause_periods_workspace_id_workflow_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_trigger_pause_periods
    ADD CONSTRAINT workflow_trigger_pause_periods_workspace_id_workflow_id_fkey FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_triggers workflow_triggers_version_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_triggers
    ADD CONSTRAINT workflow_triggers_version_fk FOREIGN KEY (workspace_id, workflow_id, workflow_version_id) REFERENCES app.workflow_versions(workspace_id, workflow_id, id) ON DELETE RESTRICT;


--
-- Name: workflow_version_dependencies workflow_version_dependencies_parent_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_version_dependencies
    ADD CONSTRAINT workflow_version_dependencies_parent_fk FOREIGN KEY (workspace_id, parent_version_id) REFERENCES app.workflow_versions(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workflow_version_dependencies workflow_version_dependencies_target_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_version_dependencies
    ADD CONSTRAINT workflow_version_dependencies_target_fk FOREIGN KEY (workspace_id, target_workflow_id, target_version_id) REFERENCES app.workflow_versions(workspace_id, workflow_id, id) ON DELETE RESTRICT;


--
-- Name: workflow_versions workflow_versions_published_by_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_versions
    ADD CONSTRAINT workflow_versions_published_by_fk FOREIGN KEY (published_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: workflow_versions workflow_versions_workflow_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflow_versions
    ADD CONSTRAINT workflow_versions_workflow_workspace_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: workflows workflows_created_by_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflows
    ADD CONSTRAINT workflows_created_by_fk FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: workflows workflows_published_version_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflows
    ADD CONSTRAINT workflows_published_version_workspace_fk FOREIGN KEY (workspace_id, id, published_version_id) REFERENCES app.workflow_versions(workspace_id, workflow_id, id) ON DELETE RESTRICT;


--
-- Name: workflows workflows_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workflows
    ADD CONSTRAINT workflows_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_creation_idempotency_records workspace_creation_idempotency_records_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_creation_idempotency_records
    ADD CONSTRAINT workspace_creation_idempotency_records_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES app.users(id);


--
-- Name: workspace_creation_idempotency_records workspace_creation_idempotency_records_resource_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_creation_idempotency_records
    ADD CONSTRAINT workspace_creation_idempotency_records_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES app.workspaces(id);


--
-- Name: workspace_data_table_quotas workspace_data_table_quotas_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_data_table_quotas
    ADD CONSTRAINT workspace_data_table_quotas_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_data_table_rows workspace_data_table_rows_workspace_id_table_id_workspace_data_; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_data_table_rows
    ADD CONSTRAINT workspace_data_table_rows_workspace_id_table_id_workspace_data_ FOREIGN KEY (workspace_id, table_id) REFERENCES app.workspace_data_tables(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workspace_data_tables workspace_data_tables_workspace_id_workspaces_id_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_data_tables
    ADD CONSTRAINT workspace_data_tables_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_execution_admission_counters workspace_execution_admission_counters_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_execution_admission_counters
    ADD CONSTRAINT workspace_execution_admission_counters_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_execution_entitlement_versions workspace_execution_entitlement_versions_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_execution_entitlement_versions
    ADD CONSTRAINT workspace_execution_entitlement_versions_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_execution_entitlements workspace_execution_entitlements_version_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_execution_entitlements
    ADD CONSTRAINT workspace_execution_entitlements_version_fk FOREIGN KEY (workspace_id, current_version) REFERENCES app.workspace_execution_entitlement_versions(workspace_id, version) ON DELETE RESTRICT;


--
-- Name: workspace_inbox_events workspace_inbox_events_run_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_inbox_events
    ADD CONSTRAINT workspace_inbox_events_run_fk FOREIGN KEY (workspace_id, run_id) REFERENCES app.workflow_runs(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workspace_inbox_events workspace_inbox_events_workflow_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_inbox_events
    ADD CONSTRAINT workspace_inbox_events_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workspace_inbox_failure_days workspace_inbox_failure_days_workspace_id_workflow_id_workflows; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_inbox_failure_days
    ADD CONSTRAINT workspace_inbox_failure_days_workspace_id_workflow_id_workflows FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workspace_inbox_reads workspace_inbox_reads_membership_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_inbox_reads
    ADD CONSTRAINT workspace_inbox_reads_membership_fk FOREIGN KEY (workspace_id, user_id) REFERENCES app.workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT;


--
-- Name: workspace_inbox_reads workspace_inbox_reads_thread_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_inbox_reads
    ADD CONSTRAINT workspace_inbox_reads_thread_fk FOREIGN KEY (workspace_id, thread_id) REFERENCES app.workspace_inbox_threads(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workspace_inbox_threads workspace_inbox_threads_comment_mention_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_inbox_threads
    ADD CONSTRAINT workspace_inbox_threads_comment_mention_fk FOREIGN KEY (workspace_id, comment_mention_id) REFERENCES app.workflow_comment_mentions(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workspace_inbox_threads workspace_inbox_threads_connection_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_inbox_threads
    ADD CONSTRAINT workspace_inbox_threads_connection_fk FOREIGN KEY (workspace_id, connection_id) REFERENCES app.connections(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: workspace_inbox_threads workspace_inbox_threads_publication_request_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_inbox_threads
    ADD CONSTRAINT workspace_inbox_threads_publication_request_fk FOREIGN KEY (workspace_id, publication_request_id) REFERENCES app.workflow_publication_requests(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workspace_inbox_threads workspace_inbox_threads_task_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_inbox_threads
    ADD CONSTRAINT workspace_inbox_threads_task_fk FOREIGN KEY (workspace_id, task_id) REFERENCES app.pending_run_tasks(workspace_id, id) ON DELETE CASCADE;


--
-- Name: workspace_inbox_threads workspace_inbox_threads_workflow_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_inbox_threads
    ADD CONSTRAINT workspace_inbox_threads_workflow_fk FOREIGN KEY (workspace_id, workflow_id) REFERENCES app.workflows(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: workspace_inbox_threads workspace_inbox_threads_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_inbox_threads
    ADD CONSTRAINT workspace_inbox_threads_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_invitation_acceptance_intents workspace_invitation_acceptance_intents_accepted_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_invitation_acceptance_intents
    ADD CONSTRAINT workspace_invitation_acceptance_intents_accepted_user_id_fkey FOREIGN KEY (accepted_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: workspace_invitation_acceptance_intents workspace_invitation_acceptance_intents_invitation_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_invitation_acceptance_intents
    ADD CONSTRAINT workspace_invitation_acceptance_intents_invitation_id_fkey FOREIGN KEY (invitation_id) REFERENCES app.workspace_invitations(id) ON DELETE CASCADE;


--
-- Name: workspace_invitation_acceptance_intents workspace_invitation_acceptance_intents_verified_user_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_invitation_acceptance_intents
    ADD CONSTRAINT workspace_invitation_acceptance_intents_verified_user_id_fkey FOREIGN KEY (verified_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: workspace_invitation_acceptance_intents workspace_invitation_acceptance_intents_workspace_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_invitation_acceptance_intents
    ADD CONSTRAINT workspace_invitation_acceptance_intents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_invitation_binding_replacement_claims workspace_invitation_binding_replacemen_prior_workspace_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_invitation_binding_replacement_claims
    ADD CONSTRAINT workspace_invitation_binding_replacemen_prior_workspace_id_fkey FOREIGN KEY (prior_workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_invitation_delivery_attempts workspace_invitation_delivery_attempts_invitation_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_invitation_delivery_attempts
    ADD CONSTRAINT workspace_invitation_delivery_attempts_invitation_id_fkey FOREIGN KEY (invitation_id) REFERENCES app.workspace_invitations(id) ON DELETE CASCADE;


--
-- Name: workspace_invitation_delivery_attempts workspace_invitation_delivery_attempts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_invitation_delivery_attempts
    ADD CONSTRAINT workspace_invitation_delivery_attempts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_invitations workspace_invitations_accepted_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_invitations
    ADD CONSTRAINT workspace_invitations_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: workspace_invitations workspace_invitations_created_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_invitations
    ADD CONSTRAINT workspace_invitations_created_by_fkey FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: workspace_invitations workspace_invitations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_invitations
    ADD CONSTRAINT workspace_invitations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_lifecycle_operations workspace_lifecycle_operations_actor_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_lifecycle_operations
    ADD CONSTRAINT workspace_lifecycle_operations_actor_fk FOREIGN KEY (actor_user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: workspace_lifecycle_operations workspace_lifecycle_operations_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_lifecycle_operations
    ADD CONSTRAINT workspace_lifecycle_operations_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_memberships workspace_memberships_user_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_memberships
    ADD CONSTRAINT workspace_memberships_user_fk FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: workspace_memberships workspace_memberships_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_memberships
    ADD CONSTRAINT workspace_memberships_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_variable_set_revisions workspace_variable_sets_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_variable_set_revisions
    ADD CONSTRAINT workspace_variable_sets_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_variables workspace_variables_set_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_variables
    ADD CONSTRAINT workspace_variables_set_fk FOREIGN KEY (workspace_id, revision) REFERENCES app.workspace_variable_set_revisions(workspace_id, revision);


--
-- Name: workspace_variables workspace_variables_workspace_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspace_variables
    ADD CONSTRAINT workspace_variables_workspace_fk FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspaces workspaces_created_by_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspaces
    ADD CONSTRAINT workspaces_created_by_fk FOREIGN KEY (created_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: workspaces workspaces_deletion_requested_by_fk; Type: FK CONSTRAINT; Schema: app; Owner: pertexo_owner
--

ALTER TABLE ONLY app.workspaces
    ADD CONSTRAINT workspaces_deletion_requested_by_fk FOREIGN KEY (deletion_requested_by) REFERENCES app.users(id) ON DELETE RESTRICT;


--
-- Name: api_tokens; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.api_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: api_tokens api_tokens_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY api_tokens_workspace_scope ON app.api_tokens TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: artifact_links; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.artifact_links ENABLE ROW LEVEL SECURITY;

--
-- Name: artifact_links artifact_links_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY artifact_links_workspace_scope ON app.artifact_links TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: artifact_owner_references; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.artifact_owner_references ENABLE ROW LEVEL SECURITY;

--
-- Name: artifact_owner_references artifact_owner_references_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY artifact_owner_references_workspace_scope ON app.artifact_owner_references TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: artifacts; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.artifacts ENABLE ROW LEVEL SECURITY;

--
-- Name: artifacts artifacts_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY artifacts_workspace_scope ON app.artifacts TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: audit_events; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.audit_events ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_events audit_events_workspace_insert; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY audit_events_workspace_insert ON app.audit_events FOR INSERT TO pertexo_app WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: audit_events audit_events_workspace_select; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY audit_events_workspace_select ON app.audit_events FOR SELECT TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: auth_directory_group_mappings; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.auth_directory_group_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_directory_memberships; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.auth_directory_memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_organization_workspaces; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.auth_organization_workspaces ENABLE ROW LEVEL SECURITY;

--
-- Name: connection_events; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.connection_events ENABLE ROW LEVEL SECURITY;

--
-- Name: connection_events connection_events_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY connection_events_workspace_scope ON app.connection_events TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: connection_health_observations; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.connection_health_observations ENABLE ROW LEVEL SECURITY;

--
-- Name: connection_health_observations connection_health_observations_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY connection_health_observations_workspace_scope ON app.connection_health_observations TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: connection_oauth2_authorizations; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.connection_oauth2_authorizations ENABLE ROW LEVEL SECURITY;

--
-- Name: connection_oauth2_authorizations connection_oauth2_authorizations_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY connection_oauth2_authorizations_workspace_scope ON app.connection_oauth2_authorizations TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: connection_oauth2_clients; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.connection_oauth2_clients ENABLE ROW LEVEL SECURITY;

--
-- Name: connection_oauth2_clients connection_oauth2_clients_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY connection_oauth2_clients_workspace_scope ON app.connection_oauth2_clients TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: connection_oauth2_tokens; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.connection_oauth2_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: connection_oauth2_tokens connection_oauth2_tokens_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY connection_oauth2_tokens_workspace_scope ON app.connection_oauth2_tokens TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: connection_secret_versions; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.connection_secret_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: connection_secret_versions connection_secret_versions_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY connection_secret_versions_workspace_scope ON app.connection_secret_versions TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: connection_shares; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.connection_shares ENABLE ROW LEVEL SECURITY;

--
-- Name: connection_shares connection_shares_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY connection_shares_workspace_scope ON app.connection_shares TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: connections; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.connections ENABLE ROW LEVEL SECURITY;

--
-- Name: connections connections_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY connections_workspace_scope ON app.connections TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: data_table_write_receipts; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.data_table_write_receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: data_table_write_receipts data_table_write_receipts_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY data_table_write_receipts_workspace_scope ON app.data_table_write_receipts TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: auth_directory_memberships directory_memberships_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY directory_memberships_workspace_scope ON app.auth_directory_memberships TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: failure_notification_destination_versions; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.failure_notification_destination_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: failure_notification_destination_versions failure_notification_destination_versions_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY failure_notification_destination_versions_workspace_scope ON app.failure_notification_destination_versions TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: failure_notification_destinations; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.failure_notification_destinations ENABLE ROW LEVEL SECURITY;

--
-- Name: failure_notification_destinations failure_notification_destinations_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY failure_notification_destinations_workspace_scope ON app.failure_notification_destinations TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: form_uploads; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.form_uploads ENABLE ROW LEVEL SECURITY;

--
-- Name: form_uploads form_uploads_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY form_uploads_workspace_scope ON app.form_uploads TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: idempotency_records; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.idempotency_records ENABLE ROW LEVEL SECURITY;

--
-- Name: idempotency_records idempotency_records_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY idempotency_records_workspace_scope ON app.idempotency_records TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_inbox_failure_days inbox_failure_days_read; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY inbox_failure_days_read ON app.workspace_inbox_failure_days FOR SELECT TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_inbox_failure_days inbox_failure_days_write; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY inbox_failure_days_write ON app.workspace_inbox_failure_days TO pertexo_app USING (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND (NULLIF(current_setting('app.actor_id'::text, true), ''::text) IS NULL))) WITH CHECK (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND (NULLIF(current_setting('app.actor_id'::text, true), ''::text) IS NULL)));


--
-- Name: inbox_receipts; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.inbox_receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: inbox_receipts inbox_receipts_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY inbox_receipts_workspace_scope ON app.inbox_receipts TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: node_attempt_connection_dispatches; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.node_attempt_connection_dispatches ENABLE ROW LEVEL SECURITY;

--
-- Name: node_attempt_connection_dispatches node_attempt_connection_dispatches_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY node_attempt_connection_dispatches_workspace_scope ON app.node_attempt_connection_dispatches TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: node_attempts; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.node_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: node_attempts node_attempts_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY node_attempts_workspace_scope ON app.node_attempts TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: node_runs; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.node_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: node_runs node_runs_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY node_runs_workspace_scope ON app.node_runs TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: notice_mail_batches; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.notice_mail_batches ENABLE ROW LEVEL SECURITY;

--
-- Name: notice_mail_batches notice_mail_batches_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY notice_mail_batches_scope ON app.notice_mail_batches TO pertexo_app USING (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND ((NULLIF(current_setting('app.actor_id'::text, true), ''::text) IS NULL) OR ((user_id)::text = current_setting('app.actor_id'::text, true))))) WITH CHECK (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND ((NULLIF(current_setting('app.actor_id'::text, true), ''::text) IS NULL) OR ((user_id)::text = current_setting('app.actor_id'::text, true)))));


--
-- Name: notice_mail_items; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.notice_mail_items ENABLE ROW LEVEL SECURITY;

--
-- Name: notice_mail_items notice_mail_items_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY notice_mail_items_scope ON app.notice_mail_items TO pertexo_app USING (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND ((NULLIF(current_setting('app.actor_id'::text, true), ''::text) IS NULL) OR (EXISTS ( SELECT 1
   FROM app.notice_mail_batches batch
  WHERE ((batch.workspace_id = notice_mail_items.workspace_id) AND (batch.id = notice_mail_items.batch_id) AND ((batch.user_id)::text = current_setting('app.actor_id'::text, true)))))))) WITH CHECK (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND ((NULLIF(current_setting('app.actor_id'::text, true), ''::text) IS NULL) OR (EXISTS ( SELECT 1
   FROM app.notice_mail_batches batch
  WHERE ((batch.workspace_id = notice_mail_items.workspace_id) AND (batch.id = notice_mail_items.batch_id) AND ((batch.user_id)::text = current_setting('app.actor_id'::text, true))))))));


--
-- Name: notice_preferences; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.notice_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: notice_preferences notice_preferences_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY notice_preferences_scope ON app.notice_preferences TO pertexo_app USING (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND ((NULLIF(current_setting('app.actor_id'::text, true), ''::text) IS NULL) OR ((user_id)::text = current_setting('app.actor_id'::text, true))))) WITH CHECK (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND ((NULLIF(current_setting('app.actor_id'::text, true), ''::text) IS NULL) OR ((user_id)::text = current_setting('app.actor_id'::text, true)))));


--
-- Name: notice_subscriptions; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.notice_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: notice_subscriptions notice_subscriptions_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY notice_subscriptions_scope ON app.notice_subscriptions TO pertexo_app USING (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND ((NULLIF(current_setting('app.actor_id'::text, true), ''::text) IS NULL) OR ((user_id)::text = current_setting('app.actor_id'::text, true))))) WITH CHECK (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND ((NULLIF(current_setting('app.actor_id'::text, true), ''::text) IS NULL) OR ((user_id)::text = current_setting('app.actor_id'::text, true)))));


--
-- Name: notice_workspace_settings; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.notice_workspace_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: notice_workspace_settings notice_workspace_settings_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY notice_workspace_settings_scope ON app.notice_workspace_settings TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: operator_commands; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.operator_commands ENABLE ROW LEVEL SECURITY;

--
-- Name: operator_commands operator_commands_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY operator_commands_workspace_scope ON app.operator_commands TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: operator_run_replay_requests; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.operator_run_replay_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: operator_run_replay_requests operator_run_replay_requests_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY operator_run_replay_requests_workspace_scope ON app.operator_run_replay_requests TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: operator_unknown_outcome_evidence operator_unknown_evidence_worker_select; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY operator_unknown_evidence_worker_select ON app.operator_unknown_outcome_evidence FOR SELECT TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: operator_unknown_outcome_evidence; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.operator_unknown_outcome_evidence ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_directory_group_mappings organization_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY organization_scope ON app.auth_directory_group_mappings TO pertexo_app USING ((organization_id =
CASE
    WHEN pg_input_is_valid(NULLIF(current_setting('app.organization_id'::text, true), ''::text), 'uuid'::text) THEN (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid
    ELSE NULL::uuid
END)) WITH CHECK ((organization_id =
CASE
    WHEN pg_input_is_valid(NULLIF(current_setting('app.organization_id'::text, true), ''::text), 'uuid'::text) THEN (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid
    ELSE NULL::uuid
END));


--
-- Name: auth_organization_workspaces organization_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY organization_scope ON app.auth_organization_workspaces TO pertexo_app USING ((organization_id =
CASE
    WHEN pg_input_is_valid(NULLIF(current_setting('app.organization_id'::text, true), ''::text), 'uuid'::text) THEN (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid
    ELSE NULL::uuid
END)) WITH CHECK ((organization_id =
CASE
    WHEN pg_input_is_valid(NULLIF(current_setting('app.organization_id'::text, true), ''::text), 'uuid'::text) THEN (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid
    ELSE NULL::uuid
END));


--
-- Name: outbox_events; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.outbox_events ENABLE ROW LEVEL SECURITY;

--
-- Name: outbox_events outbox_events_error_workflow_wakeup; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY outbox_events_error_workflow_wakeup ON app.outbox_events FOR UPDATE TO pertexo_app USING (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND ((job_name)::text = 'start-error-workflow'::text) AND (published_at IS NULL) AND (failed_at IS NULL))) WITH CHECK (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND ((job_name)::text = 'start-error-workflow'::text) AND (published_at IS NULL) AND (failed_at IS NULL)));


--
-- Name: outbox_events outbox_events_tenant_insert; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY outbox_events_tenant_insert ON app.outbox_events FOR INSERT TO pertexo_app WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: outbox_events outbox_events_tenant_select; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY outbox_events_tenant_select ON app.outbox_events FOR SELECT TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: pending_run_tasks; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.pending_run_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: pending_run_tasks pending_run_tasks_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY pending_run_tasks_workspace_scope ON app.pending_run_tasks TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: preview_attempts; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.preview_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: preview_attempts preview_attempts_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY preview_attempts_workspace_scope ON app.preview_attempts TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: preview_runs; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.preview_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: preview_runs preview_runs_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY preview_runs_workspace_scope ON app.preview_runs TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_promotion_origins promotion_origins_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY promotion_origins_workspace_scope ON app.workflow_promotion_origins TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_promotion_targets promotion_targets_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY promotion_targets_workspace_scope ON app.workspace_promotion_targets TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_publication_requests publication_requests_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY publication_requests_workspace_scope ON app.workflow_publication_requests TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: run_checkpoints; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.run_checkpoints ENABLE ROW LEVEL SECURITY;

--
-- Name: run_checkpoints run_checkpoints_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY run_checkpoints_workspace_scope ON app.run_checkpoints TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: run_error_workflow_intents; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.run_error_workflow_intents ENABLE ROW LEVEL SECURITY;

--
-- Name: run_error_workflow_intents run_error_workflow_intents_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY run_error_workflow_intents_workspace_scope ON app.run_error_workflow_intents TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: run_events; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.run_events ENABLE ROW LEVEL SECURITY;

--
-- Name: run_events run_events_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY run_events_workspace_scope ON app.run_events TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: run_failure_notification_audit_facts; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.run_failure_notification_audit_facts ENABLE ROW LEVEL SECURITY;

--
-- Name: run_failure_notification_audit_facts run_failure_notification_audit_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY run_failure_notification_audit_workspace_scope ON app.run_failure_notification_audit_facts TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: run_failure_notification_intents; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.run_failure_notification_intents ENABLE ROW LEVEL SECURITY;

--
-- Name: run_failure_notification_intents run_failure_notification_intents_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY run_failure_notification_intents_workspace_scope ON app.run_failure_notification_intents TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: transport_security_audit_facts; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.transport_security_audit_facts ENABLE ROW LEVEL SECURITY;

--
-- Name: transport_security_audit_facts transport_security_audit_facts_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY transport_security_audit_facts_workspace_scope ON app.transport_security_audit_facts TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: trigger_coordinated_events; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.trigger_coordinated_events ENABLE ROW LEVEL SECURITY;

--
-- Name: trigger_coordinated_events trigger_coordinated_events_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY trigger_coordinated_events_workspace_scope ON app.trigger_coordinated_events TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: trigger_event_windows; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.trigger_event_windows ENABLE ROW LEVEL SECURITY;

--
-- Name: trigger_event_windows trigger_event_windows_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY trigger_event_windows_workspace_scope ON app.trigger_event_windows TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: trigger_schedule_occurrences; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.trigger_schedule_occurrences ENABLE ROW LEVEL SECURITY;

--
-- Name: trigger_schedule_occurrences trigger_schedule_occurrences_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY trigger_schedule_occurrences_workspace_scope ON app.trigger_schedule_occurrences TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: trigger_schedules; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.trigger_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: trigger_schedules trigger_schedules_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY trigger_schedules_workspace_scope ON app.trigger_schedules TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: usage_events; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.usage_events ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_events usage_events_workspace_insert; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY usage_events_workspace_insert ON app.usage_events FOR INSERT TO pertexo_app WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: usage_events usage_events_workspace_select; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY usage_events_workspace_select ON app.usage_events FOR SELECT TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_version_promotions version_promotions_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY version_promotions_workspace_scope ON app.workflow_version_promotions TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: webhook_endpoint_ingress_limits; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.webhook_endpoint_ingress_limits ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_run_responses; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.webhook_run_responses ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_run_responses webhook_run_responses_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY webhook_run_responses_workspace_scope ON app.webhook_run_responses TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: webhook_test_events; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.webhook_test_events ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_test_events webhook_test_events_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY webhook_test_events_workspace_scope ON app.webhook_test_events TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: webhook_trigger_deliveries; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.webhook_trigger_deliveries ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_trigger_deliveries webhook_trigger_deliveries_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY webhook_trigger_deliveries_workspace_scope ON app.webhook_trigger_deliveries TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: webhook_trigger_endpoints; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.webhook_trigger_endpoints ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_trigger_endpoints webhook_trigger_endpoints_worker_reconciliation; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY webhook_trigger_endpoints_worker_reconciliation ON app.webhook_trigger_endpoints TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: webhook_trigger_replay_records; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.webhook_trigger_replay_records ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_trigger_replay_records webhook_trigger_replay_records_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY webhook_trigger_replay_records_workspace_scope ON app.webhook_trigger_replay_records TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: webhook_trigger_secret_versions; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.webhook_trigger_secret_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_trigger_secret_versions webhook_trigger_secret_versions_api_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY webhook_trigger_secret_versions_api_scope ON app.webhook_trigger_secret_versions TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_calls; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_calls ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_calls workflow_calls_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_calls_workspace_scope ON app.workflow_calls TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_comment_mentions; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_comment_mentions ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_comment_mentions workflow_comment_mentions_workspace; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_comment_mentions_workspace ON app.workflow_comment_mentions TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_comment_threads; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_comment_threads ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_comment_threads workflow_comment_threads_workspace; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_comment_threads_workspace ON app.workflow_comment_threads TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_comments; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_comments ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_comments workflow_comments_workspace; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_comments_workspace ON app.workflow_comments TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_concurrency_policies; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_concurrency_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_concurrency_policies workflow_concurrency_policies_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_concurrency_policies_workspace_scope ON app.workflow_concurrency_policies TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_drafts; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_drafts ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_drafts workflow_drafts_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_drafts_workspace_scope ON app.workflow_drafts TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_error_policies; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_error_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_error_policies workflow_error_policies_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_error_policies_workspace_scope ON app.workflow_error_policies TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_failure_notification_policies; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_failure_notification_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_failure_notification_policies workflow_failure_notification_policies_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_failure_notification_policies_workspace_scope ON app.workflow_failure_notification_policies TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_failure_streaks; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_failure_streaks ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_failure_streaks workflow_failure_streaks_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_failure_streaks_workspace_scope ON app.workflow_failure_streaks TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_favorites; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_favorites ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_favorites workflow_favorites_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_favorites_workspace_scope ON app.workflow_favorites TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_folder_grants; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_folder_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_folder_grants workflow_folder_grants_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_folder_grants_workspace_scope ON app.workflow_folder_grants TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_folders; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_folders ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_folders workflow_folders_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_folders_workspace_scope ON app.workflow_folders TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_forms; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_forms ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_forms workflow_forms_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_forms_workspace_scope ON app.workflow_forms TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_input_case_payloads; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_input_case_payloads ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_input_case_payloads workflow_input_case_payloads_tenant; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_input_case_payloads_tenant ON app.workflow_input_case_payloads TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_input_cases; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_input_cases ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_input_cases workflow_input_cases_tenant; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_input_cases_tenant ON app.workflow_input_cases TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_integration_usage; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_integration_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_integration_usage workflow_integration_usage_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_integration_usage_workspace_scope ON app.workflow_integration_usage TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_manual_start_rejections; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_manual_start_rejections ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_manual_start_rejections workflow_manual_start_rejections_tenant; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_manual_start_rejections_tenant ON app.workflow_manual_start_rejections TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_organization_state; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_organization_state ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_organization_state workflow_organization_state_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_organization_state_workspace_scope ON app.workflow_organization_state TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_presence_leases; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_presence_leases ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_presence_leases workflow_presence_leases_workspace; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_presence_leases_workspace ON app.workflow_presence_leases TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_promotion_origins; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_promotion_origins ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_publication_requests; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_publication_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_run_active_admissions; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_run_active_admissions ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_run_active_admissions workflow_run_active_admissions_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_run_active_admissions_workspace_scope ON app.workflow_run_active_admissions FOR SELECT TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_run_values; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_run_values ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_run_values workflow_run_values_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_run_values_workspace_scope ON app.workflow_run_values TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_runs; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_runs workflow_runs_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_runs_workspace_scope ON app.workflow_runs TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_step_samples; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_step_samples ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_step_samples workflow_step_samples_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_step_samples_workspace_scope ON app.workflow_step_samples TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_tag_assignments; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_tag_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_tag_assignments workflow_tag_assignments_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_tag_assignments_workspace_scope ON app.workflow_tag_assignments TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_tags; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_tags workflow_tags_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_tags_workspace_scope ON app.workflow_tags TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_template_origins; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_template_origins ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_template_origins workflow_template_origins_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_template_origins_workspace_scope ON app.workflow_template_origins TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_test_snapshots; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_test_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_test_snapshots workflow_test_snapshots_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_test_snapshots_workspace_scope ON app.workflow_test_snapshots TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_test_suite_cases; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_test_suite_cases ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_test_suite_cases workflow_test_suite_cases_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_test_suite_cases_workspace_scope ON app.workflow_test_suite_cases TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_test_suites; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_test_suites ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_test_suites workflow_test_suites_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_test_suites_workspace_scope ON app.workflow_test_suites TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_trigger_failures; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_trigger_failures ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_trigger_outcomes; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_trigger_outcomes ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_trigger_outcomes workflow_trigger_outcomes_worker_insert; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_trigger_outcomes_worker_insert ON app.workflow_trigger_outcomes FOR INSERT TO pertexo_app WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_trigger_pause_periods; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_trigger_pause_periods ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_trigger_pause_periods workflow_trigger_pause_periods_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_trigger_pause_periods_workspace_scope ON app.workflow_trigger_pause_periods TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_triggers; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_triggers ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_triggers workflow_triggers_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_triggers_workspace_scope ON app.workflow_triggers TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_version_dependencies; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_version_dependencies ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_version_dependencies workflow_version_dependencies_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_version_dependencies_workspace_scope ON app.workflow_version_dependencies TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflow_version_promotions; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_version_promotions ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_versions; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflow_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_versions workflow_versions_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflow_versions_workspace_scope ON app.workflow_versions TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workflows; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workflows ENABLE ROW LEVEL SECURITY;

--
-- Name: workflows workflows_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workflows_workspace_scope ON app.workflows TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_artifact_capacity; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_artifact_capacity ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_artifact_capacity workspace_artifact_capacity_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_artifact_capacity_workspace_scope ON app.workspace_artifact_capacity TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_creation_idempotency_records workspace_creation_idempotency_actor_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_creation_idempotency_actor_scope ON app.workspace_creation_idempotency_records TO pertexo_app USING (((actor_user_id)::text = NULLIF(current_setting('app.actor_id'::text, true), ''::text))) WITH CHECK (((actor_user_id)::text = NULLIF(current_setting('app.actor_id'::text, true), ''::text)));


--
-- Name: workspace_creation_idempotency_records; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_creation_idempotency_records ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_data_table_quotas; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_data_table_quotas ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_data_table_quotas workspace_data_table_quotas_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_data_table_quotas_workspace_scope ON app.workspace_data_table_quotas TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_data_table_rows; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_data_table_rows ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_data_table_rows workspace_data_table_rows_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_data_table_rows_workspace_scope ON app.workspace_data_table_rows TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_data_tables; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_data_tables ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_data_tables workspace_data_tables_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_data_tables_workspace_scope ON app.workspace_data_tables TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_execution_admission_counters; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_execution_admission_counters ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_execution_admission_counters workspace_execution_admission_counters_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_execution_admission_counters_scope ON app.workspace_execution_admission_counters TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_execution_entitlement_versions; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_execution_entitlement_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_execution_entitlement_versions workspace_execution_entitlement_versions_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_execution_entitlement_versions_scope ON app.workspace_execution_entitlement_versions TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_execution_entitlements; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_execution_entitlements ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_execution_entitlements workspace_execution_entitlements_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_execution_entitlements_scope ON app.workspace_execution_entitlements TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_inbox_events; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_inbox_events ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_inbox_events workspace_inbox_events_worker_delete; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_inbox_events_worker_delete ON app.workspace_inbox_events FOR DELETE TO pertexo_app USING (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND (NULLIF(current_setting('app.actor_id'::text, true), ''::text) IS NULL)));


--
-- Name: workspace_inbox_events workspace_inbox_events_worker_insert; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_inbox_events_worker_insert ON app.workspace_inbox_events FOR INSERT TO pertexo_app WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_inbox_events workspace_inbox_events_worker_select; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_inbox_events_worker_select ON app.workspace_inbox_events FOR SELECT TO pertexo_app USING (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND (NULLIF(current_setting('app.actor_id'::text, true), ''::text) IS NULL)));


--
-- Name: workspace_inbox_failure_days; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_inbox_failure_days ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_inbox_reads; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_inbox_reads ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_inbox_reads workspace_inbox_reads_recipient_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_inbox_reads_recipient_scope ON app.workspace_inbox_reads TO pertexo_app USING (app.workspace_inbox_recipient_eligible(workspace_id, user_id)) WITH CHECK (app.workspace_inbox_recipient_eligible(workspace_id, user_id));


--
-- Name: workspace_inbox_threads; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_inbox_threads ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_inbox_threads workspace_inbox_threads_recipient_select; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_inbox_threads_recipient_select ON app.workspace_inbox_threads FOR SELECT TO pertexo_app USING (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND ((NULLIF(current_setting('app.actor_id'::text, true), ''::text) IS NULL) OR app.workspace_inbox_recipient_eligible(workspace_id, (NULLIF(current_setting('app.actor_id'::text, true), ''::text))::uuid))));


--
-- Name: workspace_inbox_threads workspace_inbox_threads_worker_insert; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_inbox_threads_worker_insert ON app.workspace_inbox_threads FOR INSERT TO pertexo_app WITH CHECK (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND (NULLIF(current_setting('app.actor_id'::text, true), ''::text) IS NULL)));


--
-- Name: workspace_inbox_threads workspace_inbox_threads_worker_update; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_inbox_threads_worker_update ON app.workspace_inbox_threads FOR UPDATE TO pertexo_app USING (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND (NULLIF(current_setting('app.actor_id'::text, true), ''::text) IS NULL))) WITH CHECK (((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid) AND (NULLIF(current_setting('app.actor_id'::text, true), ''::text) IS NULL)));


--
-- Name: workspace_invitation_acceptance_intents; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_invitation_acceptance_intents ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_invitation_acceptance_intents workspace_invitation_acceptance_intents_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_invitation_acceptance_intents_workspace_scope ON app.workspace_invitation_acceptance_intents TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_invitation_binding_replacement_claims; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_invitation_binding_replacement_claims ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_invitation_binding_replacement_claims workspace_invitation_binding_replacement_claims_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_invitation_binding_replacement_claims_workspace_scope ON app.workspace_invitation_binding_replacement_claims TO pertexo_app USING ((prior_workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((prior_workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_invitation_delivery_attempts; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_invitation_delivery_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_invitation_delivery_attempts workspace_invitation_delivery_attempts_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_invitation_delivery_attempts_workspace_scope ON app.workspace_invitation_delivery_attempts TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_invitations; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_invitations ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_invitations workspace_invitations_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_invitations_workspace_scope ON app.workspace_invitations TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_lifecycle_operations; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_lifecycle_operations ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_lifecycle_operations workspace_lifecycle_operations_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_lifecycle_operations_workspace_scope ON app.workspace_lifecycle_operations TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_memberships; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_memberships workspace_memberships_actor_discovery; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_memberships_actor_discovery ON app.workspace_memberships FOR SELECT TO pertexo_app USING (((current_setting('app.discovery_scope'::text, true) = 'workspace_memberships'::text) AND (NULLIF(current_setting('app.workspace_id'::text, true), ''::text) IS NULL) AND ((user_id)::text = NULLIF(current_setting('app.actor_id'::text, true), ''::text)) AND ((status)::text = 'active'::text)));


--
-- Name: workspace_memberships workspace_memberships_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_memberships_workspace_scope ON app.workspace_memberships TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_promotion_targets; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_promotion_targets ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_directory_group_mappings workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_scope ON app.auth_directory_group_mappings TO pertexo_app USING ((workspace_id =
CASE
    WHEN pg_input_is_valid(NULLIF(current_setting('app.workspace_id'::text, true), ''::text), 'uuid'::text) THEN (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid
    ELSE NULL::uuid
END)) WITH CHECK ((workspace_id =
CASE
    WHEN pg_input_is_valid(NULLIF(current_setting('app.workspace_id'::text, true), ''::text), 'uuid'::text) THEN (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid
    ELSE NULL::uuid
END));


--
-- Name: auth_organization_workspaces workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_scope ON app.auth_organization_workspaces TO pertexo_app USING ((workspace_id =
CASE
    WHEN pg_input_is_valid(NULLIF(current_setting('app.workspace_id'::text, true), ''::text), 'uuid'::text) THEN (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid
    ELSE NULL::uuid
END)) WITH CHECK ((workspace_id =
CASE
    WHEN pg_input_is_valid(NULLIF(current_setting('app.workspace_id'::text, true), ''::text), 'uuid'::text) THEN (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid
    ELSE NULL::uuid
END));


--
-- Name: workspace_variable_set_revisions; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_variable_set_revisions ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_variable_set_revisions workspace_variable_sets_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_variable_sets_workspace_scope ON app.workspace_variable_set_revisions TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: workspace_variables; Type: ROW SECURITY; Schema: app; Owner: pertexo_owner
--

ALTER TABLE app.workspace_variables ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_variables workspace_variables_workspace_scope; Type: POLICY; Schema: app; Owner: pertexo_owner
--

CREATE POLICY workspace_variables_workspace_scope ON app.workspace_variables TO pertexo_app USING ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)) WITH CHECK ((workspace_id = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid));


--
-- Name: SCHEMA app; Type: ACL; Schema: -; Owner: pertexo_owner
--

GRANT USAGE ON SCHEMA app TO pertexo_app;
GRANT USAGE ON SCHEMA app TO pertexo_maintenance;


--
-- Name: SCHEMA pertexo_internal; Type: ACL; Schema: -; Owner: pertexo_owner
--

GRANT USAGE ON SCHEMA pertexo_internal TO pertexo_app;
GRANT USAGE ON SCHEMA pertexo_internal TO pertexo_maintenance;


--
-- Name: FUNCTION apply_instance_capacity(p_active_run_limit integer, p_queued_run_limit integer, p_artifact_count_limit integer); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.apply_instance_capacity(p_active_run_limit integer, p_queued_run_limit integer, p_artifact_count_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.apply_instance_capacity(p_active_run_limit integer, p_queued_run_limit integer, p_artifact_count_limit integer) TO pertexo_app;


--
-- Name: FUNCTION arm_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.arm_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.arm_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) TO pertexo_maintenance;


--
-- Name: FUNCTION artifact_capacity_purge_start(); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.artifact_capacity_purge_start() FROM PUBLIC;


--
-- Name: FUNCTION artifact_capacity_transition(); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.artifact_capacity_transition() FROM PUBLIC;


--
-- Name: FUNCTION artifact_owner_ids(p_value jsonb, p_format text); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.artifact_owner_ids(p_value jsonb, p_format text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.artifact_owner_ids(p_value jsonb, p_format text) TO pertexo_app;
GRANT ALL ON FUNCTION app.artifact_owner_ids(p_value jsonb, p_format text) TO pertexo_maintenance;


--
-- Name: FUNCTION artifact_owner_text_may_reference(p_value text); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.artifact_owner_text_may_reference(p_value text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.artifact_owner_text_may_reference(p_value text) TO pertexo_app;
GRANT ALL ON FUNCTION app.artifact_owner_text_may_reference(p_value text) TO pertexo_maintenance;


--
-- Name: FUNCTION check_execution_value_bytes(); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.check_execution_value_bytes() FROM PUBLIC;


--
-- Name: FUNCTION claim_due_node_run_wakeups(p_limit integer); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.claim_due_node_run_wakeups(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.claim_due_node_run_wakeups(p_limit integer) TO pertexo_maintenance;


--
-- Name: FUNCTION claim_due_run_failure_notification_recoveries(p_limit integer); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.claim_due_run_failure_notification_recoveries(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.claim_due_run_failure_notification_recoveries(p_limit integer) TO pertexo_maintenance;


--
-- Name: FUNCTION claim_due_trigger_schedules(p_lease_owner character varying, p_limit integer, p_lease_seconds integer); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.claim_due_trigger_schedules(p_lease_owner character varying, p_limit integer, p_lease_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.claim_due_trigger_schedules(p_lease_owner character varying, p_limit integer, p_lease_seconds integer) TO pertexo_maintenance;


--
-- Name: FUNCTION claim_due_workflow_run_deadlines(p_limit integer); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.claim_due_workflow_run_deadlines(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.claim_due_workflow_run_deadlines(p_limit integer) TO pertexo_maintenance;


--
-- Name: FUNCTION claim_workspace_inbox_events(p_limit integer); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.claim_workspace_inbox_events(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.claim_workspace_inbox_events(p_limit integer) TO pertexo_maintenance;


--
-- Name: FUNCTION delete_removed_member_private_rows(p_workspace_id uuid, p_user_ids uuid[], p_table regclass); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.delete_removed_member_private_rows(p_workspace_id uuid, p_user_ids uuid[], p_table regclass) FROM PUBLIC;
GRANT ALL ON FUNCTION app.delete_removed_member_private_rows(p_workspace_id uuid, p_user_ids uuid[], p_table regclass) TO pertexo_app;
GRANT ALL ON FUNCTION app.delete_removed_member_private_rows(p_workspace_id uuid, p_user_ids uuid[], p_table regclass) TO pertexo_maintenance;


--
-- Name: FUNCTION discover_due_coordinated_events(p_limit integer); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.discover_due_coordinated_events(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.discover_due_coordinated_events(p_limit integer) TO pertexo_maintenance;


--
-- Name: FUNCTION enforce_workflow_run_admission(); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.enforce_workflow_run_admission() FROM PUBLIC;


--
-- Name: FUNCTION execution_artifact_ids(p_value jsonb, p_format text); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.execution_artifact_ids(p_value jsonb, p_format text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.execution_artifact_ids(p_value jsonb, p_format text) TO pertexo_app;
GRANT ALL ON FUNCTION app.execution_artifact_ids(p_value jsonb, p_format text) TO pertexo_maintenance;


--
-- Name: FUNCTION has_pending_invitation(p_normalized_email character varying); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.has_pending_invitation(p_normalized_email character varying) FROM PUBLIC;
GRANT ALL ON FUNCTION app.has_pending_invitation(p_normalized_email character varying) TO pertexo_app;


--
-- Name: FUNCTION index_artifact_owner_references(); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.index_artifact_owner_references() FROM PUBLIC;


--
-- Name: FUNCTION lend_workflow_run_slot(p_workspace uuid, p_call uuid, p_child uuid, p_outbox uuid); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.lend_workflow_run_slot(p_workspace uuid, p_call uuid, p_child uuid, p_outbox uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lend_workflow_run_slot(p_workspace uuid, p_call uuid, p_child uuid, p_outbox uuid) TO pertexo_maintenance;


--
-- Name: FUNCTION lock_execution_artifact_references(); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.lock_execution_artifact_references() FROM PUBLIC;


--
-- Name: FUNCTION lock_webhook_ingress_counter(p_endpoint_key_hash character); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.lock_webhook_ingress_counter(p_endpoint_key_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_webhook_ingress_counter(p_endpoint_key_hash character) TO pertexo_app;


--
-- Name: FUNCTION lock_workflow_run_replay_source(p_workspace_id uuid, p_source_run_id uuid); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.lock_workflow_run_replay_source(p_workspace_id uuid, p_source_run_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_workflow_run_replay_source(p_workspace_id uuid, p_source_run_id uuid) TO pertexo_app;


--
-- Name: FUNCTION lock_workflow_run_replay_version(p_workspace_id uuid, p_workflow_id uuid, p_workflow_version_id uuid); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.lock_workflow_run_replay_version(p_workspace_id uuid, p_workflow_id uuid, p_workflow_version_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_workflow_run_replay_version(p_workspace_id uuid, p_workflow_id uuid, p_workflow_version_id uuid) TO pertexo_app;
GRANT ALL ON FUNCTION app.lock_workflow_run_replay_version(p_workspace_id uuid, p_workflow_id uuid, p_workflow_version_id uuid) TO pertexo_maintenance;


--
-- Name: FUNCTION lock_workspace_admission(p_workspace uuid); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.lock_workspace_admission(p_workspace uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_workspace_admission(p_workspace uuid) TO pertexo_app;


--
-- Name: FUNCTION lock_workspace_execution_counter(p_workspace uuid); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.lock_workspace_execution_counter(p_workspace uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_workspace_execution_counter(p_workspace uuid) TO pertexo_app;
GRANT ALL ON FUNCTION app.lock_workspace_execution_counter(p_workspace uuid) TO pertexo_maintenance;


--
-- Name: FUNCTION lock_workspace_run_admission(p_workspace_id uuid); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.lock_workspace_run_admission(p_workspace_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lock_workspace_run_admission(p_workspace_id uuid) TO pertexo_app;
GRANT ALL ON FUNCTION app.lock_workspace_run_admission(p_workspace_id uuid) TO pertexo_maintenance;


--
-- Name: FUNCTION lookup_public_form(p_public_id uuid, p_digest character); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.lookup_public_form(p_public_id uuid, p_digest character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.lookup_public_form(p_public_id uuid, p_digest character) TO pertexo_app;


--
-- Name: FUNCTION pending_callback_key_inventory(p_after text); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.pending_callback_key_inventory(p_after text) FROM PUBLIC;
GRANT ALL ON FUNCTION app.pending_callback_key_inventory(p_after text) TO pertexo_app;


--
-- Name: FUNCTION provision_workspace_execution_admission(); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.provision_workspace_execution_admission() FROM PUBLIC;


--
-- Name: FUNCTION rebind_workflow_run_active_admission(p_workspace_id uuid, p_workflow_run_id uuid, p_old_outbox_event_id uuid, p_new_outbox_event_id uuid); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.rebind_workflow_run_active_admission(p_workspace_id uuid, p_workflow_run_id uuid, p_old_outbox_event_id uuid, p_new_outbox_event_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.rebind_workflow_run_active_admission(p_workspace_id uuid, p_workflow_run_id uuid, p_old_outbox_event_id uuid, p_new_outbox_event_id uuid) TO pertexo_app;


--
-- Name: FUNCTION recover_due_workflow_run_active_admissions(p_limit integer); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.recover_due_workflow_run_active_admissions(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.recover_due_workflow_run_active_admissions(p_limit integer) TO pertexo_maintenance;


--
-- Name: FUNCTION refresh_workflow_run_admission_counters(); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.refresh_workflow_run_admission_counters() FROM PUBLIC;


--
-- Name: FUNCTION release_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.release_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.release_dispatcher_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) TO pertexo_maintenance;


--
-- Name: FUNCTION release_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.release_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.release_trigger_schedule_claim(p_trigger_id uuid, p_lease_token uuid) TO pertexo_maintenance;


--
-- Name: FUNCTION release_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.release_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.release_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid) TO pertexo_app;


--
-- Name: FUNCTION replace_artifact_owner_references(p_workspace uuid, p_family text, p_owner uuid, p_sub_id integer, p_row jsonb, p_values jsonb); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.replace_artifact_owner_references(p_workspace uuid, p_family text, p_owner uuid, p_sub_id integer, p_row jsonb, p_values jsonb) FROM PUBLIC;


--
-- Name: FUNCTION require_workflow_skip_protocol(); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.require_workflow_skip_protocol() FROM PUBLIC;
GRANT ALL ON FUNCTION app.require_workflow_skip_protocol() TO pertexo_app;
GRANT ALL ON FUNCTION app.require_workflow_skip_protocol() TO pertexo_maintenance;


--
-- Name: FUNCTION reserve_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.reserve_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.reserve_workflow_run_active_admission(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid) TO pertexo_maintenance;


--
-- Name: FUNCTION resolve_public_pending_callback(p_hash character); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.resolve_public_pending_callback(p_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.resolve_public_pending_callback(p_hash character) TO pertexo_app;


--
-- Name: FUNCTION resolve_public_webhook_endpoint(p_endpoint_key_hash character); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.resolve_public_webhook_endpoint(p_endpoint_key_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.resolve_public_webhook_endpoint(p_endpoint_key_hash character) TO pertexo_app;


--
-- Name: FUNCTION resolve_webhook_test_event(p_key_hash character); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.resolve_webhook_test_event(p_key_hash character) FROM PUBLIC;
GRANT ALL ON FUNCTION app.resolve_webhook_test_event(p_key_hash character) TO pertexo_app;


--
-- Name: FUNCTION return_workflow_run_slot(p_workspace uuid, p_call uuid, p_parent_outbox uuid); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.return_workflow_run_slot(p_workspace uuid, p_call uuid, p_parent_outbox uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.return_workflow_run_slot(p_workspace uuid, p_call uuid, p_parent_outbox uuid) TO pertexo_maintenance;


--
-- Name: FUNCTION revoke_auth_sessions_for_email_change(); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.revoke_auth_sessions_for_email_change() FROM PUBLIC;


--
-- Name: FUNCTION revoke_auth_sessions_for_inactive_user(); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.revoke_auth_sessions_for_inactive_user() FROM PUBLIC;


--
-- Name: FUNCTION revoke_auth_sessions_for_workspace_unavailability(); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.revoke_auth_sessions_for_workspace_unavailability() FROM PUBLIC;


--
-- Name: FUNCTION store_trigger_schedule_retirement(p_trigger_id uuid, p_lease_token uuid, p_health_status text, p_error_code text, p_deferred_until timestamp with time zone); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.store_trigger_schedule_retirement(p_trigger_id uuid, p_lease_token uuid, p_health_status text, p_error_code text, p_deferred_until timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION app.store_trigger_schedule_retirement(p_trigger_id uuid, p_lease_token uuid, p_health_status text, p_error_code text, p_deferred_until timestamp with time zone) TO pertexo_maintenance;


--
-- Name: FUNCTION store_webhook_ingress_counter(p_endpoint_key_hash character, p_expected_window timestamp with time zone, p_expected_count integer, p_reset boolean, p_window timestamp with time zone); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.store_webhook_ingress_counter(p_endpoint_key_hash character, p_expected_window timestamp with time zone, p_expected_count integer, p_reset boolean, p_window timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION app.store_webhook_ingress_counter(p_endpoint_key_hash character, p_expected_window timestamp with time zone, p_expected_count integer, p_reset boolean, p_window timestamp with time zone) TO pertexo_app;


--
-- Name: FUNCTION workflow_concurrency_admissible(p_workspace uuid, p_run uuid, p_grant boolean); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.workflow_concurrency_admissible(p_workspace uuid, p_run uuid, p_grant boolean) FROM PUBLIC;


--
-- Name: FUNCTION workflow_run_active_admission_eligible(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.workflow_run_active_admission_eligible(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.workflow_run_active_admission_eligible(p_workspace_id uuid, p_outbox_event_id uuid, p_workflow_run_id uuid) TO pertexo_maintenance;


--
-- Name: FUNCTION workflow_run_active_capacity_available(p_workspace_id uuid, p_entitlement_version integer, p_workflow_run_id uuid); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.workflow_run_active_capacity_available(p_workspace_id uuid, p_entitlement_version integer, p_workflow_run_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.workflow_run_active_capacity_available(p_workspace_id uuid, p_entitlement_version integer, p_workflow_run_id uuid) TO pertexo_app;


--
-- Name: FUNCTION workflow_run_slot_counts(p_workspace uuid, p_workflow uuid, p_excluded_run uuid); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.workflow_run_slot_counts(p_workspace uuid, p_workflow uuid, p_excluded_run uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.workflow_run_slot_counts(p_workspace uuid, p_workflow uuid, p_excluded_run uuid) TO pertexo_app;
GRANT ALL ON FUNCTION app.workflow_run_slot_counts(p_workspace uuid, p_workflow uuid, p_excluded_run uuid) TO pertexo_maintenance;


--
-- Name: FUNCTION workspace_inbox_recipient_eligible(p_workspace_id uuid, p_user_id uuid); Type: ACL; Schema: app; Owner: pertexo_owner
--

REVOKE ALL ON FUNCTION app.workspace_inbox_recipient_eligible(p_workspace_id uuid, p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app.workspace_inbox_recipient_eligible(p_workspace_id uuid, p_user_id uuid) TO pertexo_app;


--
-- Name: TABLE api_tokens; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.api_tokens TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.api_tokens TO pertexo_maintenance;


--
-- Name: COLUMN api_tokens.revoked_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(revoked_at) ON TABLE app.api_tokens TO pertexo_app;


--
-- Name: COLUMN api_tokens.last_used_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(last_used_at) ON TABLE app.api_tokens TO pertexo_app;


--
-- Name: TABLE artifact_links; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.artifact_links TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.artifact_links TO pertexo_maintenance;


--
-- Name: TABLE artifact_owner_references; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT ON TABLE app.artifact_owner_references TO pertexo_app;
GRANT SELECT ON TABLE app.artifact_owner_references TO pertexo_maintenance;


--
-- Name: TABLE artifacts; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.artifacts TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.artifacts TO pertexo_maintenance;


--
-- Name: COLUMN artifacts.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.artifacts TO pertexo_app;
GRANT UPDATE(status) ON TABLE app.artifacts TO pertexo_maintenance;


--
-- Name: COLUMN artifacts.expires_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(expires_at) ON TABLE app.artifacts TO pertexo_app;


--
-- Name: COLUMN artifacts.finalized_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(finalized_at) ON TABLE app.artifacts TO pertexo_app;


--
-- Name: COLUMN artifacts.deleted_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(deleted_at) ON TABLE app.artifacts TO pertexo_app;
GRANT UPDATE(deleted_at) ON TABLE app.artifacts TO pertexo_maintenance;


--
-- Name: COLUMN artifacts.retention_retry_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(retention_retry_at) ON TABLE app.artifacts TO pertexo_maintenance;


--
-- Name: COLUMN artifacts.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.artifacts TO pertexo_app;
GRANT UPDATE(updated_at) ON TABLE app.artifacts TO pertexo_maintenance;


--
-- Name: TABLE audit_events; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.audit_events TO pertexo_app;
GRANT SELECT,INSERT,DELETE ON TABLE app.audit_events TO pertexo_maintenance;


--
-- Name: COLUMN audit_events.actor_user_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(actor_user_id) ON TABLE app.audit_events TO pertexo_maintenance;


--
-- Name: COLUMN audit_events.target_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(target_id) ON TABLE app.audit_events TO pertexo_maintenance;


--
-- Name: COLUMN audit_events.request_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(request_id) ON TABLE app.audit_events TO pertexo_maintenance;


--
-- Name: COLUMN audit_events.trace_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(trace_id) ON TABLE app.audit_events TO pertexo_maintenance;


--
-- Name: COLUMN audit_events.metadata; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(metadata) ON TABLE app.audit_events TO pertexo_maintenance;


--
-- Name: TABLE auth_accounts; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_accounts TO pertexo_app;
GRANT DELETE ON TABLE app.auth_accounts TO pertexo_maintenance;


--
-- Name: COLUMN auth_accounts.id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(id) ON TABLE app.auth_accounts TO pertexo_maintenance;


--
-- Name: COLUMN auth_accounts.provider_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(provider_id) ON TABLE app.auth_accounts TO pertexo_maintenance;


--
-- Name: TABLE auth_directory_group_mappings; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_directory_group_mappings TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.auth_directory_group_mappings TO pertexo_maintenance;


--
-- Name: TABLE auth_directory_group_members; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_directory_group_members TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.auth_directory_group_members TO pertexo_maintenance;


--
-- Name: TABLE auth_directory_groups; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_directory_groups TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.auth_directory_groups TO pertexo_maintenance;


--
-- Name: TABLE auth_directory_memberships; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_directory_memberships TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.auth_directory_memberships TO pertexo_maintenance;


--
-- Name: TABLE auth_directory_users; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_directory_users TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.auth_directory_users TO pertexo_maintenance;


--
-- Name: TABLE auth_domains; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_domains TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.auth_domains TO pertexo_maintenance;


--
-- Name: TABLE auth_email_proofs; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,DELETE ON TABLE app.auth_email_proofs TO pertexo_maintenance;
GRANT SELECT,INSERT ON TABLE app.auth_email_proofs TO pertexo_app;


--
-- Name: COLUMN auth_email_proofs.consumed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(consumed_at) ON TABLE app.auth_email_proofs TO pertexo_app;


--
-- Name: TABLE auth_federation_attempts; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_federation_attempts TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.auth_federation_attempts TO pertexo_maintenance;


--
-- Name: TABLE auth_method_link_attempts; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.auth_method_link_attempts TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.auth_method_link_attempts TO pertexo_maintenance;


--
-- Name: TABLE auth_organization_workspaces; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_organization_workspaces TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.auth_organization_workspaces TO pertexo_maintenance;


--
-- Name: TABLE auth_organizations; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_organizations TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.auth_organizations TO pertexo_maintenance;


--
-- Name: TABLE auth_provider_checks; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_provider_checks TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.auth_provider_checks TO pertexo_maintenance;


--
-- Name: TABLE auth_providers; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_providers TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.auth_providers TO pertexo_maintenance;


--
-- Name: TABLE auth_provisioning_credentials; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_provisioning_credentials TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.auth_provisioning_credentials TO pertexo_maintenance;


--
-- Name: TABLE auth_sessions; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_sessions TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.auth_sessions TO pertexo_maintenance;


--
-- Name: TABLE auth_sign_in_attempts; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.auth_sign_in_attempts TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.auth_sign_in_attempts TO pertexo_maintenance;


--
-- Name: TABLE auth_two_factors; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_two_factors TO pertexo_app;


--
-- Name: TABLE auth_verifications; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.auth_verifications TO pertexo_app;


--
-- Name: TABLE connection_events; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.connection_events TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.connection_events TO pertexo_maintenance;


--
-- Name: TABLE connection_health_observations; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.connection_health_observations TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.connection_health_observations TO pertexo_maintenance;


--
-- Name: COLUMN connection_health_observations.applied_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(applied_at) ON TABLE app.connection_health_observations TO pertexo_app;


--
-- Name: TABLE connection_oauth2_authorizations; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.connection_oauth2_authorizations TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.connection_oauth2_authorizations TO pertexo_maintenance;


--
-- Name: TABLE connection_oauth2_clients; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.connection_oauth2_clients TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.connection_oauth2_clients TO pertexo_maintenance;


--
-- Name: TABLE connection_oauth2_tokens; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.connection_oauth2_tokens TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.connection_oauth2_tokens TO pertexo_maintenance;


--
-- Name: TABLE connection_secret_versions; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.connection_secret_versions TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.connection_secret_versions TO pertexo_maintenance;


--
-- Name: TABLE connection_shares; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.connection_shares TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.connection_shares TO pertexo_maintenance;


--
-- Name: TABLE connections; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.connections TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.connections TO pertexo_maintenance;


--
-- Name: COLUMN connections.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.connections TO pertexo_app;
GRANT UPDATE(status) ON TABLE app.connections TO pertexo_maintenance;


--
-- Name: COLUMN connections.current_secret_version_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(current_secret_version_id) ON TABLE app.connections TO pertexo_app;


--
-- Name: COLUMN connections.last_tested_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(last_tested_at) ON TABLE app.connections TO pertexo_app;


--
-- Name: COLUMN connections.last_healthy_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(last_healthy_at) ON TABLE app.connections TO pertexo_app;


--
-- Name: COLUMN connections.last_error_code; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(last_error_code) ON TABLE app.connections TO pertexo_app;


--
-- Name: COLUMN connections.health_revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(health_revision) ON TABLE app.connections TO pertexo_app;


--
-- Name: COLUMN connections.last_run_observed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(last_run_observed_at) ON TABLE app.connections TO pertexo_app;


--
-- Name: COLUMN connections.last_health_transition_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(last_health_transition_at) ON TABLE app.connections TO pertexo_app;


--
-- Name: COLUMN connections.last_health_transition_source; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(last_health_transition_source) ON TABLE app.connections TO pertexo_app;


--
-- Name: COLUMN connections.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.connections TO pertexo_app;


--
-- Name: COLUMN connections.access_mode; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(access_mode) ON TABLE app.connections TO pertexo_app;


--
-- Name: COLUMN connections.sharing_revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(sharing_revision) ON TABLE app.connections TO pertexo_app;
GRANT UPDATE(sharing_revision) ON TABLE app.connections TO pertexo_maintenance;


--
-- Name: TABLE data_table_write_receipts; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.data_table_write_receipts TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.data_table_write_receipts TO pertexo_maintenance;


--
-- Name: TABLE failure_notification_destination_versions; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.failure_notification_destination_versions TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.failure_notification_destination_versions TO pertexo_maintenance;


--
-- Name: TABLE failure_notification_destinations; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.failure_notification_destinations TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.failure_notification_destinations TO pertexo_maintenance;


--
-- Name: COLUMN failure_notification_destinations.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.failure_notification_destinations TO pertexo_app;
GRANT UPDATE(status) ON TABLE app.failure_notification_destinations TO pertexo_maintenance;


--
-- Name: COLUMN failure_notification_destinations.current_config_version; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(current_config_version) ON TABLE app.failure_notification_destinations TO pertexo_app;


--
-- Name: COLUMN failure_notification_destinations.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.failure_notification_destinations TO pertexo_app;


--
-- Name: TABLE form_uploads; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.form_uploads TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.form_uploads TO pertexo_maintenance;


--
-- Name: COLUMN form_uploads.submitted_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(submitted_at) ON TABLE app.form_uploads TO pertexo_app;


--
-- Name: TABLE idempotency_records; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.idempotency_records TO pertexo_app;
GRANT SELECT,INSERT,DELETE ON TABLE app.idempotency_records TO pertexo_maintenance;


--
-- Name: COLUMN idempotency_records.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.idempotency_records TO pertexo_app;
GRANT UPDATE(status) ON TABLE app.idempotency_records TO pertexo_maintenance;


--
-- Name: COLUMN idempotency_records.result_ref; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(result_ref) ON TABLE app.idempotency_records TO pertexo_app;
GRANT UPDATE(result_ref) ON TABLE app.idempotency_records TO pertexo_maintenance;


--
-- Name: COLUMN idempotency_records.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.idempotency_records TO pertexo_app;
GRANT UPDATE(updated_at) ON TABLE app.idempotency_records TO pertexo_maintenance;


--
-- Name: TABLE identity_security_audit_facts; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,DELETE ON TABLE app.identity_security_audit_facts TO pertexo_maintenance;
GRANT INSERT ON TABLE app.identity_security_audit_facts TO pertexo_app;


--
-- Name: TABLE inbox_receipts; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.inbox_receipts TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.inbox_receipts TO pertexo_maintenance;


--
-- Name: COLUMN inbox_receipts.completed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(completed_at) ON TABLE app.inbox_receipts TO pertexo_app;


--
-- Name: TABLE instance_capacity; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT ON TABLE app.instance_capacity TO pertexo_app;
GRANT SELECT ON TABLE app.instance_capacity TO pertexo_maintenance;


--
-- Name: TABLE node_attempt_connection_dispatches; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.node_attempt_connection_dispatches TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.node_attempt_connection_dispatches TO pertexo_maintenance;


--
-- Name: TABLE node_attempts; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.node_attempts TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.node_attempts TO pertexo_maintenance;


--
-- Name: COLUMN node_attempts.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.node_attempts TO pertexo_app;
GRANT UPDATE(status) ON TABLE app.node_attempts TO pertexo_maintenance;


--
-- Name: COLUMN node_attempts.lease_owner; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(lease_owner) ON TABLE app.node_attempts TO pertexo_app;
GRANT UPDATE(lease_owner) ON TABLE app.node_attempts TO pertexo_maintenance;


--
-- Name: COLUMN node_attempts.lease_expires_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(lease_expires_at) ON TABLE app.node_attempts TO pertexo_app;
GRANT UPDATE(lease_expires_at) ON TABLE app.node_attempts TO pertexo_maintenance;


--
-- Name: COLUMN node_attempts.fence_token; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(fence_token) ON TABLE app.node_attempts TO pertexo_app;
GRANT UPDATE(fence_token) ON TABLE app.node_attempts TO pertexo_maintenance;


--
-- Name: COLUMN node_attempts.dispatch_marked_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(dispatch_marked_at) ON TABLE app.node_attempts TO pertexo_app;


--
-- Name: COLUMN node_attempts.output_ref; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(output_ref) ON TABLE app.node_attempts TO pertexo_app;


--
-- Name: COLUMN node_attempts.safe_error_code; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(safe_error_code) ON TABLE app.node_attempts TO pertexo_app;


--
-- Name: COLUMN node_attempts.error_summary; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(error_summary) ON TABLE app.node_attempts TO pertexo_app;


--
-- Name: COLUMN node_attempts.executor_failure_kind; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(executor_failure_kind) ON TABLE app.node_attempts TO pertexo_app;


--
-- Name: COLUMN node_attempts.executor_error_kind; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(executor_error_kind) ON TABLE app.node_attempts TO pertexo_app;


--
-- Name: COLUMN node_attempts.executor_possibly_dispatched; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(executor_possibly_dispatched) ON TABLE app.node_attempts TO pertexo_app;


--
-- Name: COLUMN node_attempts.retry_decision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(retry_decision) ON TABLE app.node_attempts TO pertexo_app;


--
-- Name: COLUMN node_attempts.reconciliation_ref; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(reconciliation_ref) ON TABLE app.node_attempts TO pertexo_app;
GRANT UPDATE(reconciliation_ref) ON TABLE app.node_attempts TO pertexo_maintenance;


--
-- Name: COLUMN node_attempts.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.node_attempts TO pertexo_app;
GRANT UPDATE(updated_at) ON TABLE app.node_attempts TO pertexo_maintenance;


--
-- Name: COLUMN node_attempts.started_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(started_at) ON TABLE app.node_attempts TO pertexo_app;


--
-- Name: COLUMN node_attempts.completed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(completed_at) ON TABLE app.node_attempts TO pertexo_app;
GRANT UPDATE(completed_at) ON TABLE app.node_attempts TO pertexo_maintenance;


--
-- Name: COLUMN node_attempts.code_diagnostics; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(code_diagnostics) ON TABLE app.node_attempts TO pertexo_app;


--
-- Name: COLUMN node_attempts.executor_retry_after_millis; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(executor_retry_after_millis) ON TABLE app.node_attempts TO pertexo_app;


--
-- Name: TABLE node_runs; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.node_runs TO pertexo_app;
GRANT SELECT,DELETE,UPDATE ON TABLE app.node_runs TO pertexo_maintenance;


--
-- Name: COLUMN node_runs.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.node_runs TO pertexo_app;
GRANT UPDATE(status) ON TABLE app.node_runs TO pertexo_maintenance;


--
-- Name: COLUMN node_runs.provider_dispatch_binding; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(provider_dispatch_binding) ON TABLE app.node_runs TO pertexo_app;


--
-- Name: COLUMN node_runs.input_ref; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(input_ref) ON TABLE app.node_runs TO pertexo_app;


--
-- Name: COLUMN node_runs.output_ref; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(output_ref) ON TABLE app.node_runs TO pertexo_app;


--
-- Name: COLUMN node_runs.current_attempt_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(current_attempt_id) ON TABLE app.node_runs TO pertexo_app;
GRANT UPDATE(current_attempt_id) ON TABLE app.node_runs TO pertexo_maintenance;


--
-- Name: COLUMN node_runs.current_attempt_number; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(current_attempt_number) ON TABLE app.node_runs TO pertexo_app;
GRANT UPDATE(current_attempt_number) ON TABLE app.node_runs TO pertexo_maintenance;


--
-- Name: COLUMN node_runs.resume_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(resume_at) ON TABLE app.node_runs TO pertexo_app;


--
-- Name: COLUMN node_runs.retry_due_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(retry_due_at) ON TABLE app.node_runs TO pertexo_app;


--
-- Name: COLUMN node_runs.due_wakeup_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(due_wakeup_at) ON TABLE app.node_runs TO pertexo_app;
GRANT UPDATE(due_wakeup_at) ON TABLE app.node_runs TO pertexo_maintenance;


--
-- Name: COLUMN node_runs.control_kind; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(control_kind) ON TABLE app.node_runs TO pertexo_app;


--
-- Name: COLUMN node_runs.wait_kind; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(wait_kind) ON TABLE app.node_runs TO pertexo_app;


--
-- Name: COLUMN node_runs.safe_error_code; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(safe_error_code) ON TABLE app.node_runs TO pertexo_app;


--
-- Name: COLUMN node_runs.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.node_runs TO pertexo_app;
GRANT UPDATE(updated_at) ON TABLE app.node_runs TO pertexo_maintenance;


--
-- Name: COLUMN node_runs.started_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(started_at) ON TABLE app.node_runs TO pertexo_app;


--
-- Name: COLUMN node_runs.completed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(completed_at) ON TABLE app.node_runs TO pertexo_app;
GRANT UPDATE(completed_at) ON TABLE app.node_runs TO pertexo_maintenance;


--
-- Name: COLUMN node_runs.failure_ref; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(failure_ref) ON TABLE app.node_runs TO pertexo_app;


--
-- Name: COLUMN node_runs.failure_handler_entry_key; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(failure_handler_entry_key) ON TABLE app.node_runs TO pertexo_app;


--
-- Name: COLUMN node_runs.failure_handler_sink_key; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(failure_handler_sink_key) ON TABLE app.node_runs TO pertexo_app;


--
-- Name: COLUMN node_runs.failure_handling; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(failure_handling) ON TABLE app.node_runs TO pertexo_app;


--
-- Name: TABLE notice_mail_batches; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.notice_mail_batches TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.notice_mail_batches TO pertexo_maintenance;


--
-- Name: TABLE notice_mail_items; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.notice_mail_items TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.notice_mail_items TO pertexo_maintenance;


--
-- Name: TABLE notice_preferences; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.notice_preferences TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.notice_preferences TO pertexo_maintenance;


--
-- Name: TABLE notice_subscriptions; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.notice_subscriptions TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.notice_subscriptions TO pertexo_maintenance;


--
-- Name: TABLE notice_workspace_settings; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.notice_workspace_settings TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.notice_workspace_settings TO pertexo_maintenance;


--
-- Name: TABLE operator_commands; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE ON TABLE app.operator_commands TO pertexo_maintenance;
GRANT SELECT ON TABLE app.operator_commands TO pertexo_app;


--
-- Name: COLUMN operator_commands.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.operator_commands TO pertexo_app;


--
-- Name: COLUMN operator_commands.outcome; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(outcome) ON TABLE app.operator_commands TO pertexo_app;


--
-- Name: COLUMN operator_commands.completed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(completed_at) ON TABLE app.operator_commands TO pertexo_app;


--
-- Name: COLUMN operator_commands.result; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(result) ON TABLE app.operator_commands TO pertexo_app;


--
-- Name: TABLE operator_run_replay_requests; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT ON TABLE app.operator_run_replay_requests TO pertexo_app;
GRANT SELECT,INSERT,DELETE ON TABLE app.operator_run_replay_requests TO pertexo_maintenance;


--
-- Name: COLUMN operator_run_replay_requests.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.operator_run_replay_requests TO pertexo_app;


--
-- Name: COLUMN operator_run_replay_requests.result_run_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(result_run_id) ON TABLE app.operator_run_replay_requests TO pertexo_app;


--
-- Name: COLUMN operator_run_replay_requests.safe_error_code; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(safe_error_code) ON TABLE app.operator_run_replay_requests TO pertexo_app;


--
-- Name: COLUMN operator_run_replay_requests.completed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(completed_at) ON TABLE app.operator_run_replay_requests TO pertexo_app;


--
-- Name: TABLE operator_unknown_outcome_evidence; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE ON TABLE app.operator_unknown_outcome_evidence TO pertexo_maintenance;


--
-- Name: COLUMN operator_unknown_outcome_evidence.command_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(command_id) ON TABLE app.operator_unknown_outcome_evidence TO pertexo_app;


--
-- Name: COLUMN operator_unknown_outcome_evidence.workspace_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(workspace_id) ON TABLE app.operator_unknown_outcome_evidence TO pertexo_app;


--
-- Name: COLUMN operator_unknown_outcome_evidence.attempt_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(attempt_id) ON TABLE app.operator_unknown_outcome_evidence TO pertexo_app;


--
-- Name: TABLE outbox_events; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.outbox_events TO pertexo_app;
GRANT SELECT,INSERT,DELETE ON TABLE app.outbox_events TO pertexo_maintenance;


--
-- Name: COLUMN outbox_events.available_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(available_at) ON TABLE app.outbox_events TO pertexo_maintenance;
GRANT UPDATE(available_at) ON TABLE app.outbox_events TO pertexo_app;


--
-- Name: COLUMN outbox_events.lease_owner; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(lease_owner) ON TABLE app.outbox_events TO pertexo_maintenance;


--
-- Name: COLUMN outbox_events.lease_token; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(lease_token) ON TABLE app.outbox_events TO pertexo_maintenance;


--
-- Name: COLUMN outbox_events.lease_expires_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(lease_expires_at) ON TABLE app.outbox_events TO pertexo_maintenance;


--
-- Name: COLUMN outbox_events.publish_attempts; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(publish_attempts) ON TABLE app.outbox_events TO pertexo_maintenance;


--
-- Name: COLUMN outbox_events.published_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(published_at) ON TABLE app.outbox_events TO pertexo_maintenance;


--
-- Name: COLUMN outbox_events.failed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(failed_at) ON TABLE app.outbox_events TO pertexo_maintenance;


--
-- Name: COLUMN outbox_events.last_error_code; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(last_error_code) ON TABLE app.outbox_events TO pertexo_maintenance;


--
-- Name: COLUMN outbox_events.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.outbox_events TO pertexo_maintenance;
GRANT UPDATE(updated_at) ON TABLE app.outbox_events TO pertexo_app;


--
-- Name: COLUMN outbox_events.delivery_due_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(delivery_due_at) ON TABLE app.outbox_events TO pertexo_maintenance;


--
-- Name: COLUMN outbox_events.redeliveries; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(redeliveries) ON TABLE app.outbox_events TO pertexo_maintenance;


--
-- Name: TABLE outbox_fair_dispatch_cursor; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT ON TABLE app.outbox_fair_dispatch_cursor TO pertexo_maintenance;


--
-- Name: COLUMN outbox_fair_dispatch_cursor.last_workspace_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(last_workspace_id) ON TABLE app.outbox_fair_dispatch_cursor TO pertexo_maintenance;


--
-- Name: COLUMN outbox_fair_dispatch_cursor.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.outbox_fair_dispatch_cursor TO pertexo_maintenance;


--
-- Name: TABLE pending_run_tasks; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.pending_run_tasks TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.pending_run_tasks TO pertexo_maintenance;


--
-- Name: COLUMN pending_run_tasks.node_run_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(node_run_id) ON TABLE app.pending_run_tasks TO pertexo_app;


--
-- Name: COLUMN pending_run_tasks.invocation_key; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(invocation_key) ON TABLE app.pending_run_tasks TO pertexo_app;


--
-- Name: COLUMN pending_run_tasks.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.pending_run_tasks TO pertexo_app;


--
-- Name: COLUMN pending_run_tasks.output_ref; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(output_ref) ON TABLE app.pending_run_tasks TO pertexo_app;


--
-- Name: COLUMN pending_run_tasks.decided_by; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(decided_by) ON TABLE app.pending_run_tasks TO pertexo_app;


--
-- Name: COLUMN pending_run_tasks.expires_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(expires_at) ON TABLE app.pending_run_tasks TO pertexo_app;


--
-- Name: COLUMN pending_run_tasks.completed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(completed_at) ON TABLE app.pending_run_tasks TO pertexo_app;


--
-- Name: COLUMN pending_run_tasks.consumed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(consumed_at) ON TABLE app.pending_run_tasks TO pertexo_app;
GRANT UPDATE(consumed_at) ON TABLE app.pending_run_tasks TO pertexo_maintenance;


--
-- Name: COLUMN pending_run_tasks.opened_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(opened_at) ON TABLE app.pending_run_tasks TO pertexo_app;


--
-- Name: TABLE preview_attempts; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.preview_attempts TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.preview_attempts TO pertexo_maintenance;


--
-- Name: COLUMN preview_attempts.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.preview_attempts TO pertexo_app;
GRANT UPDATE(status) ON TABLE app.preview_attempts TO pertexo_maintenance;


--
-- Name: COLUMN preview_attempts.provider_dispatch_binding; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(provider_dispatch_binding) ON TABLE app.preview_attempts TO pertexo_app;


--
-- Name: COLUMN preview_attempts.lease_owner; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(lease_owner) ON TABLE app.preview_attempts TO pertexo_app;
GRANT UPDATE(lease_owner) ON TABLE app.preview_attempts TO pertexo_maintenance;


--
-- Name: COLUMN preview_attempts.lease_expires_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(lease_expires_at) ON TABLE app.preview_attempts TO pertexo_app;
GRANT UPDATE(lease_expires_at) ON TABLE app.preview_attempts TO pertexo_maintenance;


--
-- Name: COLUMN preview_attempts.fence_token; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(fence_token) ON TABLE app.preview_attempts TO pertexo_app;
GRANT UPDATE(fence_token) ON TABLE app.preview_attempts TO pertexo_maintenance;


--
-- Name: COLUMN preview_attempts.dispatch_marked_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(dispatch_marked_at) ON TABLE app.preview_attempts TO pertexo_app;


--
-- Name: COLUMN preview_attempts.output_ref; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(output_ref) ON TABLE app.preview_attempts TO pertexo_app;


--
-- Name: COLUMN preview_attempts.safe_error_code; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(safe_error_code) ON TABLE app.preview_attempts TO pertexo_app;
GRANT UPDATE(safe_error_code) ON TABLE app.preview_attempts TO pertexo_maintenance;


--
-- Name: COLUMN preview_attempts.reconciliation_ref; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(reconciliation_ref) ON TABLE app.preview_attempts TO pertexo_app;


--
-- Name: COLUMN preview_attempts.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.preview_attempts TO pertexo_app;
GRANT UPDATE(updated_at) ON TABLE app.preview_attempts TO pertexo_maintenance;


--
-- Name: COLUMN preview_attempts.started_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(started_at) ON TABLE app.preview_attempts TO pertexo_app;
GRANT UPDATE(started_at) ON TABLE app.preview_attempts TO pertexo_maintenance;


--
-- Name: COLUMN preview_attempts.completed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(completed_at) ON TABLE app.preview_attempts TO pertexo_app;
GRANT UPDATE(completed_at) ON TABLE app.preview_attempts TO pertexo_maintenance;


--
-- Name: COLUMN preview_attempts.code_diagnostics; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(code_diagnostics) ON TABLE app.preview_attempts TO pertexo_app;


--
-- Name: COLUMN preview_attempts.error_summary; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(error_summary) ON TABLE app.preview_attempts TO pertexo_app;
GRANT UPDATE(error_summary) ON TABLE app.preview_attempts TO pertexo_maintenance;


--
-- Name: TABLE preview_runs; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.preview_runs TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.preview_runs TO pertexo_maintenance;


--
-- Name: COLUMN preview_runs.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.preview_runs TO pertexo_app;
GRANT UPDATE(status) ON TABLE app.preview_runs TO pertexo_maintenance;


--
-- Name: COLUMN preview_runs.output_ref; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(output_ref) ON TABLE app.preview_runs TO pertexo_app;


--
-- Name: COLUMN preview_runs.safe_error_code; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(safe_error_code) ON TABLE app.preview_runs TO pertexo_app;
GRANT UPDATE(safe_error_code) ON TABLE app.preview_runs TO pertexo_maintenance;


--
-- Name: COLUMN preview_runs.started_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(started_at) ON TABLE app.preview_runs TO pertexo_app;
GRANT UPDATE(started_at) ON TABLE app.preview_runs TO pertexo_maintenance;


--
-- Name: COLUMN preview_runs.completed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(completed_at) ON TABLE app.preview_runs TO pertexo_app;
GRANT UPDATE(completed_at) ON TABLE app.preview_runs TO pertexo_maintenance;


--
-- Name: COLUMN preview_runs.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.preview_runs TO pertexo_app;
GRANT UPDATE(updated_at) ON TABLE app.preview_runs TO pertexo_maintenance;


--
-- Name: TABLE run_checkpoints; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.run_checkpoints TO pertexo_app;
GRANT SELECT,INSERT,DELETE ON TABLE app.run_checkpoints TO pertexo_maintenance;


--
-- Name: COLUMN run_checkpoints.revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(revision) ON TABLE app.run_checkpoints TO pertexo_app;


--
-- Name: COLUMN run_checkpoints.scheduler_state; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(scheduler_state) ON TABLE app.run_checkpoints TO pertexo_app;


--
-- Name: COLUMN run_checkpoints.resume_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(resume_at) ON TABLE app.run_checkpoints TO pertexo_app;
GRANT UPDATE(resume_at) ON TABLE app.run_checkpoints TO pertexo_maintenance;


--
-- Name: COLUMN run_checkpoints.resume_lease_owner; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(resume_lease_owner) ON TABLE app.run_checkpoints TO pertexo_app;
GRANT UPDATE(resume_lease_owner) ON TABLE app.run_checkpoints TO pertexo_maintenance;


--
-- Name: COLUMN run_checkpoints.resume_lease_token; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(resume_lease_token) ON TABLE app.run_checkpoints TO pertexo_app;
GRANT UPDATE(resume_lease_token) ON TABLE app.run_checkpoints TO pertexo_maintenance;


--
-- Name: COLUMN run_checkpoints.resume_lease_expires_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(resume_lease_expires_at) ON TABLE app.run_checkpoints TO pertexo_app;
GRANT UPDATE(resume_lease_expires_at) ON TABLE app.run_checkpoints TO pertexo_maintenance;


--
-- Name: COLUMN run_checkpoints.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.run_checkpoints TO pertexo_app;
GRANT UPDATE(updated_at) ON TABLE app.run_checkpoints TO pertexo_maintenance;


--
-- Name: TABLE run_error_workflow_intents; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.run_error_workflow_intents TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.run_error_workflow_intents TO pertexo_maintenance;


--
-- Name: COLUMN run_error_workflow_intents.outbox_event_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(outbox_event_id) ON TABLE app.run_error_workflow_intents TO pertexo_app;
GRANT UPDATE(outbox_event_id) ON TABLE app.run_error_workflow_intents TO pertexo_maintenance;


--
-- Name: COLUMN run_error_workflow_intents.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.run_error_workflow_intents TO pertexo_app;


--
-- Name: COLUMN run_error_workflow_intents.accepted_run_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(accepted_run_id) ON TABLE app.run_error_workflow_intents TO pertexo_app;


--
-- Name: COLUMN run_error_workflow_intents.refusal_code; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(refusal_code) ON TABLE app.run_error_workflow_intents TO pertexo_app;


--
-- Name: COLUMN run_error_workflow_intents.completed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(completed_at) ON TABLE app.run_error_workflow_intents TO pertexo_app;


--
-- Name: COLUMN run_error_workflow_intents.queue_wait_expires_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(queue_wait_expires_at) ON TABLE app.run_error_workflow_intents TO pertexo_app;


--
-- Name: TABLE run_events; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.run_events TO pertexo_app;
GRANT SELECT,INSERT,DELETE ON TABLE app.run_events TO pertexo_maintenance;


--
-- Name: TABLE run_failure_notification_audit_facts; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.run_failure_notification_audit_facts TO pertexo_app;
GRANT SELECT,INSERT,DELETE ON TABLE app.run_failure_notification_audit_facts TO pertexo_maintenance;


--
-- Name: TABLE run_failure_notification_intents; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.run_failure_notification_intents TO pertexo_app;
GRANT SELECT,DELETE,UPDATE ON TABLE app.run_failure_notification_intents TO pertexo_maintenance;


--
-- Name: COLUMN run_failure_notification_intents.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.run_failure_notification_intents TO pertexo_app;


--
-- Name: COLUMN run_failure_notification_intents.delivery_attempts; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(delivery_attempts) ON TABLE app.run_failure_notification_intents TO pertexo_app;


--
-- Name: COLUMN run_failure_notification_intents.dispatch_marked_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(dispatch_marked_at) ON TABLE app.run_failure_notification_intents TO pertexo_app;


--
-- Name: COLUMN run_failure_notification_intents.recovery_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(recovery_at) ON TABLE app.run_failure_notification_intents TO pertexo_app;


--
-- Name: COLUMN run_failure_notification_intents.next_delivery_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(next_delivery_at) ON TABLE app.run_failure_notification_intents TO pertexo_app;


--
-- Name: COLUMN run_failure_notification_intents.safe_error_code; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(safe_error_code) ON TABLE app.run_failure_notification_intents TO pertexo_app;


--
-- Name: COLUMN run_failure_notification_intents.possibly_dispatched; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(possibly_dispatched) ON TABLE app.run_failure_notification_intents TO pertexo_app;


--
-- Name: COLUMN run_failure_notification_intents.provider_reference; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(provider_reference) ON TABLE app.run_failure_notification_intents TO pertexo_app;


--
-- Name: COLUMN run_failure_notification_intents.completed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(completed_at) ON TABLE app.run_failure_notification_intents TO pertexo_app;


--
-- Name: COLUMN run_failure_notification_intents.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.run_failure_notification_intents TO pertexo_app;


--
-- Name: COLUMN run_failure_notification_intents.delivery_binding; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(delivery_binding) ON TABLE app.run_failure_notification_intents TO pertexo_app;


--
-- Name: COLUMN run_failure_notification_intents.dispatched_config_version; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(dispatched_config_version) ON TABLE app.run_failure_notification_intents TO pertexo_app;


--
-- Name: COLUMN run_failure_notification_intents.dispatched_secret_version_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(dispatched_secret_version_id) ON TABLE app.run_failure_notification_intents TO pertexo_app;


--
-- Name: TABLE system_mail_deliveries; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,DELETE ON TABLE app.system_mail_deliveries TO pertexo_maintenance;
GRANT SELECT,INSERT ON TABLE app.system_mail_deliveries TO pertexo_app;


--
-- Name: COLUMN system_mail_deliveries.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.system_mail_deliveries TO pertexo_maintenance;
GRANT UPDATE(status) ON TABLE app.system_mail_deliveries TO pertexo_app;


--
-- Name: COLUMN system_mail_deliveries.next_attempt_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(next_attempt_at) ON TABLE app.system_mail_deliveries TO pertexo_app;


--
-- Name: COLUMN system_mail_deliveries.attempt_count; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(attempt_count) ON TABLE app.system_mail_deliveries TO pertexo_app;


--
-- Name: COLUMN system_mail_deliveries.lease_owner; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(lease_owner) ON TABLE app.system_mail_deliveries TO pertexo_maintenance;
GRANT UPDATE(lease_owner) ON TABLE app.system_mail_deliveries TO pertexo_app;


--
-- Name: COLUMN system_mail_deliveries.lease_token; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(lease_token) ON TABLE app.system_mail_deliveries TO pertexo_maintenance;
GRANT UPDATE(lease_token) ON TABLE app.system_mail_deliveries TO pertexo_app;


--
-- Name: COLUMN system_mail_deliveries.lease_generation; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(lease_generation) ON TABLE app.system_mail_deliveries TO pertexo_app;


--
-- Name: COLUMN system_mail_deliveries.lease_expires_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(lease_expires_at) ON TABLE app.system_mail_deliveries TO pertexo_maintenance;
GRANT UPDATE(lease_expires_at) ON TABLE app.system_mail_deliveries TO pertexo_app;


--
-- Name: COLUMN system_mail_deliveries.payload_ciphertext; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(payload_ciphertext) ON TABLE app.system_mail_deliveries TO pertexo_maintenance;
GRANT UPDATE(payload_ciphertext) ON TABLE app.system_mail_deliveries TO pertexo_app;


--
-- Name: COLUMN system_mail_deliveries.payload_nonce; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(payload_nonce) ON TABLE app.system_mail_deliveries TO pertexo_maintenance;
GRANT UPDATE(payload_nonce) ON TABLE app.system_mail_deliveries TO pertexo_app;


--
-- Name: COLUMN system_mail_deliveries.payload_tag; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(payload_tag) ON TABLE app.system_mail_deliveries TO pertexo_maintenance;
GRANT UPDATE(payload_tag) ON TABLE app.system_mail_deliveries TO pertexo_app;


--
-- Name: COLUMN system_mail_deliveries.payload_key_version; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(payload_key_version) ON TABLE app.system_mail_deliveries TO pertexo_maintenance;
GRANT UPDATE(payload_key_version) ON TABLE app.system_mail_deliveries TO pertexo_app;


--
-- Name: COLUMN system_mail_deliveries.provider_reference; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(provider_reference) ON TABLE app.system_mail_deliveries TO pertexo_app;


--
-- Name: COLUMN system_mail_deliveries.failure_code; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(failure_code) ON TABLE app.system_mail_deliveries TO pertexo_app;


--
-- Name: COLUMN system_mail_deliveries.completed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(completed_at) ON TABLE app.system_mail_deliveries TO pertexo_maintenance;
GRANT UPDATE(completed_at) ON TABLE app.system_mail_deliveries TO pertexo_app;


--
-- Name: COLUMN system_mail_deliveries.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.system_mail_deliveries TO pertexo_maintenance;
GRANT UPDATE(updated_at) ON TABLE app.system_mail_deliveries TO pertexo_app;


--
-- Name: COLUMN system_mail_deliveries.had_uncertain_attempt; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(had_uncertain_attempt) ON TABLE app.system_mail_deliveries TO pertexo_app;
GRANT UPDATE(had_uncertain_attempt) ON TABLE app.system_mail_deliveries TO pertexo_maintenance;


--
-- Name: TABLE transport_security_audit_facts; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.transport_security_audit_facts TO pertexo_app;
GRANT SELECT,INSERT,DELETE ON TABLE app.transport_security_audit_facts TO pertexo_maintenance;


--
-- Name: COLUMN transport_security_audit_facts.consumer_name; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(consumer_name) ON TABLE app.transport_security_audit_facts TO pertexo_maintenance;


--
-- Name: COLUMN transport_security_audit_facts.message_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(message_id) ON TABLE app.transport_security_audit_facts TO pertexo_maintenance;


--
-- Name: TABLE trigger_coordinated_events; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.trigger_coordinated_events TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.trigger_coordinated_events TO pertexo_maintenance;


--
-- Name: TABLE trigger_event_windows; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.trigger_event_windows TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.trigger_event_windows TO pertexo_maintenance;


--
-- Name: TABLE trigger_schedule_occurrences; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.trigger_schedule_occurrences TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.trigger_schedule_occurrences TO pertexo_maintenance;


--
-- Name: TABLE trigger_schedules; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.trigger_schedules TO pertexo_app;
GRANT SELECT,DELETE,UPDATE ON TABLE app.trigger_schedules TO pertexo_maintenance;


--
-- Name: COLUMN trigger_schedules.anchor_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(anchor_at) ON TABLE app.trigger_schedules TO pertexo_app;


--
-- Name: COLUMN trigger_schedules.next_fire_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(next_fire_at) ON TABLE app.trigger_schedules TO pertexo_app;


--
-- Name: COLUMN trigger_schedules.last_fire_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(last_fire_at) ON TABLE app.trigger_schedules TO pertexo_app;


--
-- Name: COLUMN trigger_schedules.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.trigger_schedules TO pertexo_app;


--
-- Name: COLUMN trigger_schedules.health_status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(health_status) ON TABLE app.trigger_schedules TO pertexo_app;


--
-- Name: COLUMN trigger_schedules.last_error_code; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(last_error_code) ON TABLE app.trigger_schedules TO pertexo_app;


--
-- Name: COLUMN trigger_schedules.lease_owner; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(lease_owner) ON TABLE app.trigger_schedules TO pertexo_app;


--
-- Name: COLUMN trigger_schedules.lease_token; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(lease_token) ON TABLE app.trigger_schedules TO pertexo_app;


--
-- Name: COLUMN trigger_schedules.lease_acquired_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(lease_acquired_at) ON TABLE app.trigger_schedules TO pertexo_app;


--
-- Name: COLUMN trigger_schedules.lease_expires_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(lease_expires_at) ON TABLE app.trigger_schedules TO pertexo_app;


--
-- Name: COLUMN trigger_schedules.admission_deferred_until; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(admission_deferred_until) ON TABLE app.trigger_schedules TO pertexo_app;


--
-- Name: COLUMN trigger_schedules.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.trigger_schedules TO pertexo_app;


--
-- Name: COLUMN trigger_schedules.retired_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(retired_at) ON TABLE app.trigger_schedules TO pertexo_app;


--
-- Name: TABLE usage_events; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.usage_events TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.usage_events TO pertexo_maintenance;


--
-- Name: COLUMN usage_events.id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT INSERT(id) ON TABLE app.usage_events TO pertexo_maintenance;


--
-- Name: COLUMN usage_events.workspace_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT INSERT(workspace_id) ON TABLE app.usage_events TO pertexo_maintenance;


--
-- Name: COLUMN usage_events.category; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT INSERT(category) ON TABLE app.usage_events TO pertexo_maintenance;


--
-- Name: COLUMN usage_events.quantity; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT INSERT(quantity) ON TABLE app.usage_events TO pertexo_maintenance;


--
-- Name: COLUMN usage_events.resource_type; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT INSERT(resource_type),UPDATE(resource_type) ON TABLE app.usage_events TO pertexo_maintenance;


--
-- Name: COLUMN usage_events.resource_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT INSERT(resource_id),UPDATE(resource_id) ON TABLE app.usage_events TO pertexo_maintenance;


--
-- Name: COLUMN usage_events.idempotency_key; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT INSERT(idempotency_key),UPDATE(idempotency_key) ON TABLE app.usage_events TO pertexo_maintenance;


--
-- Name: COLUMN usage_events.metadata; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT INSERT(metadata),UPDATE(metadata) ON TABLE app.usage_events TO pertexo_maintenance;


--
-- Name: COLUMN usage_events.occurred_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT INSERT(occurred_at) ON TABLE app.usage_events TO pertexo_maintenance;


--
-- Name: TABLE user_profile_command_receipts; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.user_profile_command_receipts TO pertexo_app;


--
-- Name: COLUMN user_profile_command_receipts.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.user_profile_command_receipts TO pertexo_app;


--
-- Name: COLUMN user_profile_command_receipts.result_ref; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(result_ref) ON TABLE app.user_profile_command_receipts TO pertexo_app;


--
-- Name: COLUMN user_profile_command_receipts.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.user_profile_command_receipts TO pertexo_app;


--
-- Name: TABLE users; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.users TO pertexo_app;


--
-- Name: COLUMN users.email; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(email) ON TABLE app.users TO pertexo_app;


--
-- Name: COLUMN users.display_name; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(display_name) ON TABLE app.users TO pertexo_app;


--
-- Name: COLUMN users.email_verified; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(email_verified) ON TABLE app.users TO pertexo_app;


--
-- Name: COLUMN users.image; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(image) ON TABLE app.users TO pertexo_app;


--
-- Name: COLUMN users.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.users TO pertexo_app;


--
-- Name: COLUMN users.profile_revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(profile_revision) ON TABLE app.users TO pertexo_app;


--
-- Name: COLUMN users.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.users TO pertexo_app;


--
-- Name: COLUMN users.two_factor_enabled; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(two_factor_enabled) ON TABLE app.users TO pertexo_app;


--
-- Name: TABLE webhook_endpoint_ingress_limits; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,DELETE ON TABLE app.webhook_endpoint_ingress_limits TO pertexo_maintenance;


--
-- Name: TABLE webhook_run_responses; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.webhook_run_responses TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.webhook_run_responses TO pertexo_maintenance;


--
-- Name: TABLE webhook_test_events; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.webhook_test_events TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.webhook_test_events TO pertexo_maintenance;


--
-- Name: COLUMN webhook_test_events.expires_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(expires_at) ON TABLE app.webhook_test_events TO pertexo_maintenance;


--
-- Name: TABLE webhook_trigger_deliveries; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.webhook_trigger_deliveries TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.webhook_trigger_deliveries TO pertexo_maintenance;


--
-- Name: TABLE webhook_trigger_endpoints; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.webhook_trigger_endpoints TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.webhook_trigger_endpoints TO pertexo_maintenance;


--
-- Name: COLUMN webhook_trigger_endpoints.id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(id) ON TABLE app.webhook_trigger_endpoints TO pertexo_app;


--
-- Name: COLUMN webhook_trigger_endpoints.workspace_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(workspace_id) ON TABLE app.webhook_trigger_endpoints TO pertexo_app;


--
-- Name: COLUMN webhook_trigger_endpoints.endpoint_key_hash; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(endpoint_key_hash) ON TABLE app.webhook_trigger_endpoints TO pertexo_app;


--
-- Name: COLUMN webhook_trigger_endpoints.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(status),UPDATE(status) ON TABLE app.webhook_trigger_endpoints TO pertexo_app;


--
-- Name: COLUMN webhook_trigger_endpoints.current_secret_version_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(current_secret_version_id) ON TABLE app.webhook_trigger_endpoints TO pertexo_app;


--
-- Name: COLUMN webhook_trigger_endpoints.previous_secret_version_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(previous_secret_version_id) ON TABLE app.webhook_trigger_endpoints TO pertexo_app;


--
-- Name: COLUMN webhook_trigger_endpoints.previous_secret_valid_until; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(previous_secret_valid_until) ON TABLE app.webhook_trigger_endpoints TO pertexo_app;


--
-- Name: COLUMN webhook_trigger_endpoints.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.webhook_trigger_endpoints TO pertexo_app;


--
-- Name: COLUMN webhook_trigger_endpoints.authentication; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(authentication) ON TABLE app.webhook_trigger_endpoints TO pertexo_app;


--
-- Name: TABLE webhook_trigger_replay_records; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE ON TABLE app.webhook_trigger_replay_records TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.webhook_trigger_replay_records TO pertexo_maintenance;


--
-- Name: COLUMN webhook_trigger_replay_records.workflow_run_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(workflow_run_id) ON TABLE app.webhook_trigger_replay_records TO pertexo_app;


--
-- Name: COLUMN webhook_trigger_replay_records.skip_reason; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(skip_reason) ON TABLE app.webhook_trigger_replay_records TO pertexo_app;


--
-- Name: COLUMN webhook_trigger_replay_records.coordination_event_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(coordination_event_id) ON TABLE app.webhook_trigger_replay_records TO pertexo_app;


--
-- Name: TABLE webhook_trigger_secret_versions; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT INSERT ON TABLE app.webhook_trigger_secret_versions TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.webhook_trigger_secret_versions TO pertexo_maintenance;


--
-- Name: TABLE workflow_calls; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workflow_calls TO pertexo_app;
GRANT SELECT,INSERT,DELETE ON TABLE app.workflow_calls TO pertexo_maintenance;


--
-- Name: COLUMN workflow_calls.input_ref; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(input_ref) ON TABLE app.workflow_calls TO pertexo_maintenance;


--
-- Name: COLUMN workflow_calls.deadline_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(deadline_at) ON TABLE app.workflow_calls TO pertexo_app;


--
-- Name: COLUMN workflow_calls.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.workflow_calls TO pertexo_app;
GRANT UPDATE(status) ON TABLE app.workflow_calls TO pertexo_maintenance;


--
-- Name: COLUMN workflow_calls.child_run_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(child_run_id) ON TABLE app.workflow_calls TO pertexo_app;
GRANT UPDATE(child_run_id) ON TABLE app.workflow_calls TO pertexo_maintenance;


--
-- Name: COLUMN workflow_calls.live_child_run_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(live_child_run_id) ON TABLE app.workflow_calls TO pertexo_app;
GRANT UPDATE(live_child_run_id) ON TABLE app.workflow_calls TO pertexo_maintenance;


--
-- Name: COLUMN workflow_calls.result_ref; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(result_ref) ON TABLE app.workflow_calls TO pertexo_app;
GRANT UPDATE(result_ref) ON TABLE app.workflow_calls TO pertexo_maintenance;


--
-- Name: COLUMN workflow_calls.safe_error_code; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(safe_error_code) ON TABLE app.workflow_calls TO pertexo_app;
GRANT UPDATE(safe_error_code) ON TABLE app.workflow_calls TO pertexo_maintenance;


--
-- Name: COLUMN workflow_calls.slot_lent; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(slot_lent) ON TABLE app.workflow_calls TO pertexo_app;
GRANT UPDATE(slot_lent) ON TABLE app.workflow_calls TO pertexo_maintenance;


--
-- Name: COLUMN workflow_calls.consumed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(consumed_at) ON TABLE app.workflow_calls TO pertexo_app;
GRANT UPDATE(consumed_at) ON TABLE app.workflow_calls TO pertexo_maintenance;


--
-- Name: COLUMN workflow_calls.details_purged_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(details_purged_at) ON TABLE app.workflow_calls TO pertexo_maintenance;


--
-- Name: COLUMN workflow_calls.cancel_requested_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(cancel_requested_at) ON TABLE app.workflow_calls TO pertexo_app;
GRANT UPDATE(cancel_requested_at) ON TABLE app.workflow_calls TO pertexo_maintenance;


--
-- Name: COLUMN workflow_calls.cancel_applied_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(cancel_applied_at) ON TABLE app.workflow_calls TO pertexo_app;
GRANT UPDATE(cancel_applied_at) ON TABLE app.workflow_calls TO pertexo_maintenance;


--
-- Name: COLUMN workflow_calls.completed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(completed_at) ON TABLE app.workflow_calls TO pertexo_app;
GRANT UPDATE(completed_at) ON TABLE app.workflow_calls TO pertexo_maintenance;


--
-- Name: TABLE workflow_comment_mentions; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.workflow_comment_mentions TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_comment_mentions TO pertexo_maintenance;


--
-- Name: TABLE workflow_comment_threads; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.workflow_comment_threads TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_comment_threads TO pertexo_maintenance;


--
-- Name: TABLE workflow_comments; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.workflow_comments TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_comments TO pertexo_maintenance;


--
-- Name: TABLE workflow_concurrency_policies; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,DELETE ON TABLE app.workflow_concurrency_policies TO pertexo_maintenance;
GRANT SELECT,INSERT ON TABLE app.workflow_concurrency_policies TO pertexo_app;


--
-- Name: COLUMN workflow_concurrency_policies.active_run_limit; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(active_run_limit) ON TABLE app.workflow_concurrency_policies TO pertexo_app;


--
-- Name: COLUMN workflow_concurrency_policies.revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(revision) ON TABLE app.workflow_concurrency_policies TO pertexo_app;


--
-- Name: COLUMN workflow_concurrency_policies.overflow; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(overflow) ON TABLE app.workflow_concurrency_policies TO pertexo_app;


--
-- Name: TABLE workflow_drafts; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workflow_drafts TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_drafts TO pertexo_maintenance;


--
-- Name: COLUMN workflow_drafts.revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(revision) ON TABLE app.workflow_drafts TO pertexo_app;


--
-- Name: COLUMN workflow_drafts.graph_json; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(graph_json) ON TABLE app.workflow_drafts TO pertexo_app;


--
-- Name: COLUMN workflow_drafts.updated_by; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_by) ON TABLE app.workflow_drafts TO pertexo_app;


--
-- Name: COLUMN workflow_drafts.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.workflow_drafts TO pertexo_app;


--
-- Name: TABLE workflow_error_policies; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workflow_error_policies TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_error_policies TO pertexo_maintenance;


--
-- Name: COLUMN workflow_error_policies.target_workflow_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(target_workflow_id) ON TABLE app.workflow_error_policies TO pertexo_app;


--
-- Name: COLUMN workflow_error_policies.revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(revision) ON TABLE app.workflow_error_policies TO pertexo_app;


--
-- Name: TABLE workflow_failure_notification_policies; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.workflow_failure_notification_policies TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_failure_notification_policies TO pertexo_maintenance;


--
-- Name: COLUMN workflow_failure_notification_policies.destination_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(destination_id) ON TABLE app.workflow_failure_notification_policies TO pertexo_maintenance;


--
-- Name: TABLE workflow_failure_streaks; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.workflow_failure_streaks TO pertexo_maintenance;
GRANT INSERT ON TABLE app.workflow_failure_streaks TO pertexo_app;


--
-- Name: COLUMN workflow_failure_streaks.workspace_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(workspace_id) ON TABLE app.workflow_failure_streaks TO pertexo_app;


--
-- Name: COLUMN workflow_failure_streaks.workflow_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(workflow_id) ON TABLE app.workflow_failure_streaks TO pertexo_app;


--
-- Name: COLUMN workflow_failure_streaks.consecutive_failures; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(consecutive_failures) ON TABLE app.workflow_failure_streaks TO pertexo_app;


--
-- Name: COLUMN workflow_failure_streaks.resumed_after; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(resumed_after) ON TABLE app.workflow_failure_streaks TO pertexo_app;


--
-- Name: COLUMN workflow_failure_streaks.last_run_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(last_run_id) ON TABLE app.workflow_failure_streaks TO pertexo_app;


--
-- Name: COLUMN workflow_failure_streaks.last_ended_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(last_ended_at) ON TABLE app.workflow_failure_streaks TO pertexo_app;


--
-- Name: COLUMN workflow_failure_streaks.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.workflow_failure_streaks TO pertexo_app;


--
-- Name: COLUMN workflow_failure_streaks.legacy_failures; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(legacy_failures) ON TABLE app.workflow_failure_streaks TO pertexo_app;


--
-- Name: TABLE workflow_favorites; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE ON TABLE app.workflow_favorites TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_favorites TO pertexo_maintenance;


--
-- Name: TABLE workflow_folder_grants; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.workflow_folder_grants TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_folder_grants TO pertexo_maintenance;


--
-- Name: TABLE workflow_folders; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE ON TABLE app.workflow_folders TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_folders TO pertexo_maintenance;


--
-- Name: COLUMN workflow_folders.parent_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(parent_id) ON TABLE app.workflow_folders TO pertexo_app;


--
-- Name: COLUMN workflow_folders.name; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(name) ON TABLE app.workflow_folders TO pertexo_app;


--
-- Name: COLUMN workflow_folders.name_key; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(name_key) ON TABLE app.workflow_folders TO pertexo_app;


--
-- Name: COLUMN workflow_folders.revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(revision) ON TABLE app.workflow_folders TO pertexo_app;
GRANT UPDATE(revision) ON TABLE app.workflow_folders TO pertexo_maintenance;


--
-- Name: COLUMN workflow_folders.access_mode; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(access_mode) ON TABLE app.workflow_folders TO pertexo_app;


--
-- Name: TABLE workflow_forms; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workflow_forms TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_forms TO pertexo_maintenance;


--
-- Name: COLUMN workflow_forms.node_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(node_id) ON TABLE app.workflow_forms TO pertexo_app;


--
-- Name: COLUMN workflow_forms.access; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(access) ON TABLE app.workflow_forms TO pertexo_app;


--
-- Name: COLUMN workflow_forms.capability_hash; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(capability_hash) ON TABLE app.workflow_forms TO pertexo_app;


--
-- Name: COLUMN workflow_forms.revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(revision) ON TABLE app.workflow_forms TO pertexo_app;


--
-- Name: COLUMN workflow_forms.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.workflow_forms TO pertexo_app;


--
-- Name: COLUMN workflow_forms.sealed_capability; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(sealed_capability) ON TABLE app.workflow_forms TO pertexo_app;


--
-- Name: TABLE workflow_input_case_payloads; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workflow_input_case_payloads TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_input_case_payloads TO pertexo_maintenance;


--
-- Name: TABLE workflow_input_cases; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workflow_input_cases TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_input_cases TO pertexo_maintenance;


--
-- Name: COLUMN workflow_input_cases.name; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(name) ON TABLE app.workflow_input_cases TO pertexo_app;


--
-- Name: COLUMN workflow_input_cases.revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(revision) ON TABLE app.workflow_input_cases TO pertexo_app;


--
-- Name: COLUMN workflow_input_cases.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.workflow_input_cases TO pertexo_app;


--
-- Name: COLUMN workflow_input_cases.deleted_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(deleted_at) ON TABLE app.workflow_input_cases TO pertexo_app;


--
-- Name: TABLE workflow_integration_usage; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE ON TABLE app.workflow_integration_usage TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_integration_usage TO pertexo_maintenance;


--
-- Name: TABLE workflow_manual_start_rejections; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workflow_manual_start_rejections TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_manual_start_rejections TO pertexo_maintenance;


--
-- Name: TABLE workflow_organization_state; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workflow_organization_state TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_organization_state TO pertexo_maintenance;


--
-- Name: COLUMN workflow_organization_state.revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(revision) ON TABLE app.workflow_organization_state TO pertexo_app;


--
-- Name: COLUMN workflow_organization_state.folder_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(folder_id) ON TABLE app.workflow_organization_state TO pertexo_app;


--
-- Name: TABLE workflow_presence_leases; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.workflow_presence_leases TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_presence_leases TO pertexo_maintenance;


--
-- Name: TABLE workflow_promotion_origins; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.workflow_promotion_origins TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_promotion_origins TO pertexo_maintenance;


--
-- Name: TABLE workflow_publication_requests; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.workflow_publication_requests TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_publication_requests TO pertexo_maintenance;


--
-- Name: TABLE workflow_run_active_admissions; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,DELETE ON TABLE app.workflow_run_active_admissions TO pertexo_maintenance;
GRANT SELECT ON TABLE app.workflow_run_active_admissions TO pertexo_app;


--
-- Name: TABLE workflow_run_values; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.workflow_run_values TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_run_values TO pertexo_maintenance;


--
-- Name: COLUMN workflow_run_values.id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(id) ON TABLE app.workflow_run_values TO pertexo_maintenance;


--
-- Name: TABLE workflow_runs; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workflow_runs TO pertexo_app;
GRANT SELECT,INSERT,DELETE ON TABLE app.workflow_runs TO pertexo_maintenance;


--
-- Name: COLUMN workflow_runs.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.workflow_runs TO pertexo_app;


--
-- Name: COLUMN workflow_runs.deadline_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(deadline_at) ON TABLE app.workflow_runs TO pertexo_app;


--
-- Name: COLUMN workflow_runs.deadline_wakeup_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(deadline_wakeup_at) ON TABLE app.workflow_runs TO pertexo_owner;
GRANT UPDATE(deadline_wakeup_at) ON TABLE app.workflow_runs TO pertexo_app;
GRANT UPDATE(deadline_wakeup_at) ON TABLE app.workflow_runs TO pertexo_maintenance;


--
-- Name: COLUMN workflow_runs.cancel_requested_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(cancel_requested_at) ON TABLE app.workflow_runs TO pertexo_app;
GRANT UPDATE(cancel_requested_at) ON TABLE app.workflow_runs TO pertexo_maintenance;


--
-- Name: COLUMN workflow_runs.cancel_requested_by; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(cancel_requested_by) ON TABLE app.workflow_runs TO pertexo_app;
GRANT UPDATE(cancel_requested_by) ON TABLE app.workflow_runs TO pertexo_maintenance;


--
-- Name: COLUMN workflow_runs.cancel_reason; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(cancel_reason) ON TABLE app.workflow_runs TO pertexo_app;
GRANT UPDATE(cancel_reason) ON TABLE app.workflow_runs TO pertexo_maintenance;


--
-- Name: COLUMN workflow_runs.started_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(started_at) ON TABLE app.workflow_runs TO pertexo_app;


--
-- Name: COLUMN workflow_runs.completed_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(completed_at) ON TABLE app.workflow_runs TO pertexo_app;


--
-- Name: COLUMN workflow_runs.input_ref; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(input_ref) ON TABLE app.workflow_runs TO pertexo_maintenance;


--
-- Name: COLUMN workflow_runs.input_ref_expires_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(input_ref_expires_at) ON TABLE app.workflow_runs TO pertexo_maintenance;


--
-- Name: COLUMN workflow_runs.details_purged_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(details_purged_at) ON TABLE app.workflow_runs TO pertexo_maintenance;


--
-- Name: COLUMN workflow_runs.output_ref; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(output_ref) ON TABLE app.workflow_runs TO pertexo_app;
GRANT UPDATE(output_ref) ON TABLE app.workflow_runs TO pertexo_maintenance;


--
-- Name: COLUMN workflow_runs.error_summary; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(error_summary) ON TABLE app.workflow_runs TO pertexo_app;
GRANT UPDATE(error_summary) ON TABLE app.workflow_runs TO pertexo_maintenance;


--
-- Name: COLUMN workflow_runs.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.workflow_runs TO pertexo_app;
GRANT UPDATE(updated_at) ON TABLE app.workflow_runs TO pertexo_maintenance;


--
-- Name: COLUMN workflow_runs.handled_failure_count; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(handled_failure_count) ON TABLE app.workflow_runs TO pertexo_app;


--
-- Name: COLUMN workflow_runs.human_wait_started_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(human_wait_started_at) ON TABLE app.workflow_runs TO pertexo_app;


--
-- Name: COLUMN workflow_runs.remaining_execution_ms; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(remaining_execution_ms) ON TABLE app.workflow_runs TO pertexo_app;


--
-- Name: COLUMN workflow_runs.variable_set_revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(variable_set_revision) ON TABLE app.workflow_runs TO pertexo_maintenance;


--
-- Name: COLUMN workflow_runs.timed_wait_started_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(timed_wait_started_at) ON TABLE app.workflow_runs TO pertexo_app;


--
-- Name: TABLE workflow_step_samples; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.workflow_step_samples TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_step_samples TO pertexo_maintenance;


--
-- Name: COLUMN workflow_step_samples.expires_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(expires_at) ON TABLE app.workflow_step_samples TO pertexo_maintenance;


--
-- Name: TABLE workflow_tag_assignments; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE ON TABLE app.workflow_tag_assignments TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_tag_assignments TO pertexo_maintenance;


--
-- Name: TABLE workflow_tags; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE ON TABLE app.workflow_tags TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_tags TO pertexo_maintenance;


--
-- Name: COLUMN workflow_tags.key; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(key) ON TABLE app.workflow_tags TO pertexo_app;


--
-- Name: COLUMN workflow_tags.revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(revision) ON TABLE app.workflow_tags TO pertexo_app;


--
-- Name: TABLE workflow_template_origins; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workflow_template_origins TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_template_origins TO pertexo_maintenance;


--
-- Name: TABLE workflow_test_snapshots; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workflow_test_snapshots TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_test_snapshots TO pertexo_maintenance;


--
-- Name: COLUMN workflow_test_snapshots.expires_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(expires_at) ON TABLE app.workflow_test_snapshots TO pertexo_app;


--
-- Name: TABLE workflow_test_suite_cases; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.workflow_test_suite_cases TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_test_suite_cases TO pertexo_maintenance;


--
-- Name: TABLE workflow_test_suites; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.workflow_test_suites TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_test_suites TO pertexo_maintenance;


--
-- Name: TABLE workflow_trigger_failures; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE ON TABLE app.workflow_trigger_failures TO pertexo_maintenance;


--
-- Name: TABLE workflow_trigger_outcomes; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT INSERT ON TABLE app.workflow_trigger_outcomes TO pertexo_app;
GRANT SELECT,DELETE,UPDATE ON TABLE app.workflow_trigger_outcomes TO pertexo_maintenance;


--
-- Name: TABLE workflow_trigger_pause_periods; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,DELETE ON TABLE app.workflow_trigger_pause_periods TO pertexo_maintenance;
GRANT SELECT,INSERT ON TABLE app.workflow_trigger_pause_periods TO pertexo_app;


--
-- Name: TABLE workflow_triggers; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE ON TABLE app.workflow_triggers TO pertexo_app;
GRANT SELECT,DELETE,UPDATE ON TABLE app.workflow_triggers TO pertexo_maintenance;


--
-- Name: COLUMN workflow_triggers.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.workflow_triggers TO pertexo_app;


--
-- Name: COLUMN workflow_triggers.desired_config; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(desired_config) ON TABLE app.workflow_triggers TO pertexo_app;


--
-- Name: COLUMN workflow_triggers.config_fingerprint; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(config_fingerprint) ON TABLE app.workflow_triggers TO pertexo_app;


--
-- Name: COLUMN workflow_triggers.health_status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(health_status) ON TABLE app.workflow_triggers TO pertexo_app;


--
-- Name: COLUMN workflow_triggers.last_error_code; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(last_error_code) ON TABLE app.workflow_triggers TO pertexo_app;


--
-- Name: COLUMN workflow_triggers.reconciled_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(reconciled_at) ON TABLE app.workflow_triggers TO pertexo_app;


--
-- Name: COLUMN workflow_triggers.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.workflow_triggers TO pertexo_app;


--
-- Name: TABLE workflow_version_dependencies; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workflow_version_dependencies TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_version_dependencies TO pertexo_maintenance;


--
-- Name: TABLE workflow_version_promotions; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workflow_version_promotions TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_version_promotions TO pertexo_maintenance;


--
-- Name: TABLE workflow_versions; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workflow_versions TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflow_versions TO pertexo_maintenance;


--
-- Name: COLUMN workflow_versions.id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(id) ON TABLE app.workflow_versions TO pertexo_app;


--
-- Name: COLUMN workflow_versions.workspace_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(workspace_id) ON TABLE app.workflow_versions TO pertexo_app;


--
-- Name: COLUMN workflow_versions.workflow_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(workflow_id) ON TABLE app.workflow_versions TO pertexo_app;


--
-- Name: COLUMN workflow_versions.version_number; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(version_number) ON TABLE app.workflow_versions TO pertexo_app;


--
-- Name: COLUMN workflow_versions.checksum; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(checksum) ON TABLE app.workflow_versions TO pertexo_app;


--
-- Name: COLUMN workflow_versions.executable_json; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(executable_json) ON TABLE app.workflow_versions TO pertexo_app;


--
-- Name: TABLE workflows; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workflows TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workflows TO pertexo_maintenance;


--
-- Name: COLUMN workflows.id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(id) ON TABLE app.workflows TO pertexo_app;


--
-- Name: COLUMN workflows.workspace_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(workspace_id) ON TABLE app.workflows TO pertexo_app;


--
-- Name: COLUMN workflows.name; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(name) ON TABLE app.workflows TO pertexo_app;


--
-- Name: COLUMN workflows.name_revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(name_revision) ON TABLE app.workflows TO pertexo_app;


--
-- Name: COLUMN workflows.lifecycle_status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(lifecycle_status),UPDATE(lifecycle_status) ON TABLE app.workflows TO pertexo_app;


--
-- Name: COLUMN workflows.lifecycle_revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(lifecycle_revision) ON TABLE app.workflows TO pertexo_app;


--
-- Name: COLUMN workflows.activation_status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(activation_status),UPDATE(activation_status) ON TABLE app.workflows TO pertexo_app;


--
-- Name: COLUMN workflows.published_version_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(published_version_id),UPDATE(published_version_id) ON TABLE app.workflows TO pertexo_app;
GRANT UPDATE(published_version_id) ON TABLE app.workflows TO pertexo_maintenance;


--
-- Name: COLUMN workflows.auto_pause_enabled; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(auto_pause_enabled) ON TABLE app.workflows TO pertexo_app;


--
-- Name: COLUMN workflows.auto_pause_threshold; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(auto_pause_threshold) ON TABLE app.workflows TO pertexo_app;


--
-- Name: COLUMN workflows.auto_pause_settings_revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(auto_pause_settings_revision) ON TABLE app.workflows TO pertexo_app;


--
-- Name: COLUMN workflows.trigger_pause_state; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(trigger_pause_state) ON TABLE app.workflows TO pertexo_app;
GRANT UPDATE(trigger_pause_state) ON TABLE app.workflows TO pertexo_maintenance;


--
-- Name: COLUMN workflows.trigger_paused_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(trigger_paused_at) ON TABLE app.workflows TO pertexo_app;
GRANT UPDATE(trigger_paused_at) ON TABLE app.workflows TO pertexo_maintenance;


--
-- Name: COLUMN workflows.trigger_pause_reason; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(trigger_pause_reason) ON TABLE app.workflows TO pertexo_app;
GRANT UPDATE(trigger_pause_reason) ON TABLE app.workflows TO pertexo_maintenance;


--
-- Name: COLUMN workflows.trigger_pause_failures; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(trigger_pause_failures) ON TABLE app.workflows TO pertexo_app;
GRANT UPDATE(trigger_pause_failures) ON TABLE app.workflows TO pertexo_maintenance;


--
-- Name: COLUMN workflows.trigger_pause_last_run_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(trigger_pause_last_run_id) ON TABLE app.workflows TO pertexo_app;
GRANT UPDATE(trigger_pause_last_run_id) ON TABLE app.workflows TO pertexo_maintenance;


--
-- Name: COLUMN workflows.trigger_pause_revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(trigger_pause_revision) ON TABLE app.workflows TO pertexo_app;
GRANT UPDATE(trigger_pause_revision) ON TABLE app.workflows TO pertexo_maintenance;


--
-- Name: COLUMN workflows.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.workflows TO pertexo_app;


--
-- Name: TABLE workspace_artifact_capacity; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT ON TABLE app.workspace_artifact_capacity TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_artifact_capacity TO pertexo_maintenance;


--
-- Name: TABLE workspace_creation_idempotency_records; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workspace_creation_idempotency_records TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_creation_idempotency_records TO pertexo_maintenance;


--
-- Name: COLUMN workspace_creation_idempotency_records.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.workspace_creation_idempotency_records TO pertexo_app;


--
-- Name: COLUMN workspace_creation_idempotency_records.resource_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(resource_id) ON TABLE app.workspace_creation_idempotency_records TO pertexo_app;


--
-- Name: COLUMN workspace_creation_idempotency_records.result_ref; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(result_ref) ON TABLE app.workspace_creation_idempotency_records TO pertexo_app;


--
-- Name: COLUMN workspace_creation_idempotency_records.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.workspace_creation_idempotency_records TO pertexo_app;


--
-- Name: TABLE workspace_data_table_quotas; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.workspace_data_table_quotas TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_data_table_quotas TO pertexo_maintenance;


--
-- Name: TABLE workspace_data_table_rows; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.workspace_data_table_rows TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_data_table_rows TO pertexo_maintenance;


--
-- Name: TABLE workspace_data_tables; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.workspace_data_tables TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_data_tables TO pertexo_maintenance;


--
-- Name: COLUMN workspace_data_tables.id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(id) ON TABLE app.workspace_data_tables TO pertexo_maintenance;


--
-- Name: TABLE workspace_execution_admission_counters; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT ON TABLE app.workspace_execution_admission_counters TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_execution_admission_counters TO pertexo_maintenance;


--
-- Name: TABLE workspace_execution_entitlement_versions; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT ON TABLE app.workspace_execution_entitlement_versions TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_execution_entitlement_versions TO pertexo_maintenance;


--
-- Name: TABLE workspace_execution_entitlements; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT ON TABLE app.workspace_execution_entitlements TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_execution_entitlements TO pertexo_maintenance;


--
-- Name: TABLE workspace_inbox_events; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE ON TABLE app.workspace_inbox_events TO pertexo_app;
GRANT SELECT,DELETE,UPDATE ON TABLE app.workspace_inbox_events TO pertexo_maintenance;


--
-- Name: TABLE workspace_inbox_failure_days; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.workspace_inbox_failure_days TO pertexo_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.workspace_inbox_failure_days TO pertexo_maintenance;


--
-- Name: TABLE workspace_inbox_reads; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workspace_inbox_reads TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_inbox_reads TO pertexo_maintenance;


--
-- Name: COLUMN workspace_inbox_reads.read_revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(read_revision) ON TABLE app.workspace_inbox_reads TO pertexo_app;


--
-- Name: COLUMN workspace_inbox_reads.read_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(read_at) ON TABLE app.workspace_inbox_reads TO pertexo_app;


--
-- Name: SEQUENCE workspace_inbox_revision_seq; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT USAGE ON SEQUENCE app.workspace_inbox_revision_seq TO pertexo_app;
GRANT USAGE ON SEQUENCE app.workspace_inbox_revision_seq TO pertexo_maintenance;


--
-- Name: TABLE workspace_inbox_threads; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.workspace_inbox_threads TO pertexo_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.workspace_inbox_threads TO pertexo_maintenance;


--
-- Name: TABLE workspace_invitation_acceptance_intents; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.workspace_invitation_acceptance_intents TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_invitation_acceptance_intents TO pertexo_maintenance;


--
-- Name: COLUMN workspace_invitation_acceptance_intents.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.workspace_invitation_acceptance_intents TO pertexo_maintenance;


--
-- Name: COLUMN workspace_invitation_acceptance_intents.verified_user_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(verified_user_id) ON TABLE app.workspace_invitation_acceptance_intents TO pertexo_maintenance;


--
-- Name: COLUMN workspace_invitation_acceptance_intents.verified_email; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(verified_email) ON TABLE app.workspace_invitation_acceptance_intents TO pertexo_maintenance;


--
-- Name: COLUMN workspace_invitation_acceptance_intents.verified_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(verified_at) ON TABLE app.workspace_invitation_acceptance_intents TO pertexo_maintenance;


--
-- Name: COLUMN workspace_invitation_acceptance_intents.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.workspace_invitation_acceptance_intents TO pertexo_maintenance;


--
-- Name: COLUMN workspace_invitation_acceptance_intents.verified_session_id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(verified_session_id) ON TABLE app.workspace_invitation_acceptance_intents TO pertexo_maintenance;


--
-- Name: TABLE workspace_invitation_binding_replacement_claims; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.workspace_invitation_binding_replacement_claims TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_invitation_binding_replacement_claims TO pertexo_maintenance;


--
-- Name: TABLE workspace_invitation_delivery_attempts; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.workspace_invitation_delivery_attempts TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_invitation_delivery_attempts TO pertexo_maintenance;


--
-- Name: COLUMN workspace_invitation_delivery_attempts.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.workspace_invitation_delivery_attempts TO pertexo_app;
GRANT UPDATE(status) ON TABLE app.workspace_invitation_delivery_attempts TO pertexo_maintenance;


--
-- Name: COLUMN workspace_invitation_delivery_attempts.token_ciphertext; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(token_ciphertext) ON TABLE app.workspace_invitation_delivery_attempts TO pertexo_app;
GRANT UPDATE(token_ciphertext) ON TABLE app.workspace_invitation_delivery_attempts TO pertexo_maintenance;


--
-- Name: COLUMN workspace_invitation_delivery_attempts.token_nonce; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(token_nonce) ON TABLE app.workspace_invitation_delivery_attempts TO pertexo_app;
GRANT UPDATE(token_nonce) ON TABLE app.workspace_invitation_delivery_attempts TO pertexo_maintenance;


--
-- Name: COLUMN workspace_invitation_delivery_attempts.token_tag; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(token_tag) ON TABLE app.workspace_invitation_delivery_attempts TO pertexo_app;
GRANT UPDATE(token_tag) ON TABLE app.workspace_invitation_delivery_attempts TO pertexo_maintenance;


--
-- Name: COLUMN workspace_invitation_delivery_attempts.token_key_version; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(token_key_version) ON TABLE app.workspace_invitation_delivery_attempts TO pertexo_app;
GRANT UPDATE(token_key_version) ON TABLE app.workspace_invitation_delivery_attempts TO pertexo_maintenance;


--
-- Name: COLUMN workspace_invitation_delivery_attempts.provider_reference; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(provider_reference) ON TABLE app.workspace_invitation_delivery_attempts TO pertexo_app;


--
-- Name: COLUMN workspace_invitation_delivery_attempts.failure_code; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(failure_code) ON TABLE app.workspace_invitation_delivery_attempts TO pertexo_app;


--
-- Name: COLUMN workspace_invitation_delivery_attempts.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.workspace_invitation_delivery_attempts TO pertexo_app;
GRANT UPDATE(updated_at) ON TABLE app.workspace_invitation_delivery_attempts TO pertexo_maintenance;


--
-- Name: TABLE workspace_invitations; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.workspace_invitations TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_invitations TO pertexo_maintenance;


--
-- Name: COLUMN workspace_invitations.recipient_email; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(recipient_email) ON TABLE app.workspace_invitations TO pertexo_maintenance;


--
-- Name: COLUMN workspace_invitations.normalized_email; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(normalized_email) ON TABLE app.workspace_invitations TO pertexo_maintenance;


--
-- Name: COLUMN workspace_invitations.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.workspace_invitations TO pertexo_maintenance;


--
-- Name: COLUMN workspace_invitations.delivery_status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(delivery_status) ON TABLE app.workspace_invitations TO pertexo_app;
GRANT UPDATE(delivery_status) ON TABLE app.workspace_invitations TO pertexo_maintenance;


--
-- Name: COLUMN workspace_invitations.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.workspace_invitations TO pertexo_app;
GRANT UPDATE(updated_at) ON TABLE app.workspace_invitations TO pertexo_maintenance;


--
-- Name: TABLE workspace_lifecycle_operations; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workspace_lifecycle_operations TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_lifecycle_operations TO pertexo_maintenance;


--
-- Name: TABLE workspace_memberships; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workspace_memberships TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_memberships TO pertexo_maintenance;


--
-- Name: COLUMN workspace_memberships.role; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(role) ON TABLE app.workspace_memberships TO pertexo_app;
GRANT UPDATE(role) ON TABLE app.workspace_memberships TO pertexo_maintenance;


--
-- Name: COLUMN workspace_memberships.role_revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(role_revision) ON TABLE app.workspace_memberships TO pertexo_app;
GRANT UPDATE(role_revision) ON TABLE app.workspace_memberships TO pertexo_maintenance;


--
-- Name: COLUMN workspace_memberships.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(status) ON TABLE app.workspace_memberships TO pertexo_app;
GRANT UPDATE(status) ON TABLE app.workspace_memberships TO pertexo_maintenance;


--
-- Name: COLUMN workspace_memberships.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.workspace_memberships TO pertexo_app;
GRANT UPDATE(updated_at) ON TABLE app.workspace_memberships TO pertexo_maintenance;


--
-- Name: TABLE workspace_promotion_targets; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.workspace_promotion_targets TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_promotion_targets TO pertexo_maintenance;


--
-- Name: TABLE workspace_variable_set_revisions; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workspace_variable_set_revisions TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_variable_set_revisions TO pertexo_maintenance;


--
-- Name: COLUMN workspace_variable_set_revisions.created_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(created_at) ON TABLE app.workspace_variable_set_revisions TO pertexo_maintenance;


--
-- Name: TABLE workspace_variables; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workspace_variables TO pertexo_app;
GRANT SELECT,DELETE ON TABLE app.workspace_variables TO pertexo_maintenance;


--
-- Name: COLUMN workspace_variables.revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(revision) ON TABLE app.workspace_variables TO pertexo_app;


--
-- Name: COLUMN workspace_variables.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.workspace_variables TO pertexo_app;


--
-- Name: TABLE workspaces; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT,INSERT ON TABLE app.workspaces TO pertexo_app;
GRANT SELECT ON TABLE app.workspaces TO pertexo_maintenance;


--
-- Name: COLUMN workspaces.id; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(id) ON TABLE app.workspaces TO pertexo_app;


--
-- Name: COLUMN workspaces.name; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(name) ON TABLE app.workspaces TO pertexo_app;
GRANT UPDATE(name) ON TABLE app.workspaces TO pertexo_maintenance;


--
-- Name: COLUMN workspaces.slug; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(slug) ON TABLE app.workspaces TO pertexo_maintenance;


--
-- Name: COLUMN workspaces.status; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT SELECT(status),UPDATE(status) ON TABLE app.workspaces TO pertexo_app;
GRANT UPDATE(status) ON TABLE app.workspaces TO pertexo_maintenance;


--
-- Name: COLUMN workspaces.revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(revision) ON TABLE app.workspaces TO pertexo_app;


--
-- Name: COLUMN workspaces.created_by; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(created_by) ON TABLE app.workspaces TO pertexo_maintenance;


--
-- Name: COLUMN workspaces.deletion_requested_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(deletion_requested_at) ON TABLE app.workspaces TO pertexo_app;


--
-- Name: COLUMN workspaces.deletion_requested_by; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(deletion_requested_by) ON TABLE app.workspaces TO pertexo_app;
GRANT UPDATE(deletion_requested_by) ON TABLE app.workspaces TO pertexo_maintenance;


--
-- Name: COLUMN workspaces.deletion_reason; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(deletion_reason) ON TABLE app.workspaces TO pertexo_app;
GRANT UPDATE(deletion_reason) ON TABLE app.workspaces TO pertexo_maintenance;


--
-- Name: COLUMN workspaces.purge_after; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(purge_after) ON TABLE app.workspaces TO pertexo_app;


--
-- Name: COLUMN workspaces.auto_pause_threshold; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(auto_pause_threshold) ON TABLE app.workspaces TO pertexo_app;


--
-- Name: COLUMN workspaces.updated_at; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(updated_at) ON TABLE app.workspaces TO pertexo_app;
GRANT UPDATE(updated_at) ON TABLE app.workspaces TO pertexo_maintenance;


--
-- Name: COLUMN workspaces.audit_retention_days; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(audit_retention_days) ON TABLE app.workspaces TO pertexo_app;


--
-- Name: COLUMN workspaces.governance_revision; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(governance_revision) ON TABLE app.workspaces TO pertexo_app;


--
-- Name: COLUMN workspaces.require_publish_approval; Type: ACL; Schema: app; Owner: pertexo_owner
--

GRANT UPDATE(require_publish_approval) ON TABLE app.workspaces TO pertexo_app;


--
-- Name: TABLE schema_migrations; Type: ACL; Schema: pertexo_internal; Owner: pertexo_owner
--

GRANT SELECT ON TABLE pertexo_internal.schema_migrations TO pertexo_app;
GRANT SELECT ON TABLE pertexo_internal.schema_migrations TO pertexo_maintenance;


--
-- Name: TABLE write_probe; Type: ACL; Schema: pertexo_internal; Owner: pertexo_owner
--

GRANT INSERT,TRUNCATE ON TABLE pertexo_internal.write_probe TO pertexo_app;


--
-- PostgreSQL database dump complete
--


