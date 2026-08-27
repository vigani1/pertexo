-- First operator-command vertical slice: durable, idempotent redispatch of one
-- terminally failed outbox event without granting direct table access.

CREATE TABLE app.operator_commands (
  id uuid PRIMARY KEY,
  command_type varchar(64) NOT NULL,
  dry_run boolean NOT NULL,
  request_fingerprint char(64) NOT NULL,
  status varchar(16) NOT NULL,
  outcome varchar(32) NOT NULL,
  prior_publish_attempts integer,
  prior_failed_at timestamptz,
  prior_error_code varchar(128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT operator_commands_type_valid
    CHECK(command_type IN ('outbox.redispatch')),
  CONSTRAINT operator_commands_fingerprint_valid
    CHECK(request_fingerprint~'^[0-9a-f]{64}$'),
  CONSTRAINT operator_commands_status_valid CHECK(status='completed'),
  CONSTRAINT operator_commands_outcome_valid CHECK(outcome IN (
    'not_found','not_failed','already_published','would_redispatch','redispatched'
  )),
  CONSTRAINT operator_commands_prior_attempts_valid
    CHECK(prior_publish_attempts IS NULL OR prior_publish_attempts>=0),
  CONSTRAINT operator_commands_completion_order CHECK(completed_at>=created_at)
);

CREATE POLICY outbox_events_operator_command_select ON app.outbox_events
  FOR SELECT TO {{owner_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));
CREATE POLICY outbox_events_operator_command_update ON app.outbox_events
  FOR UPDATE TO {{owner_role}}
  USING(workspace_id::text=nullif(current_setting('app.workspace_id',true),''))
  WITH CHECK(workspace_id::text=nullif(current_setting('app.workspace_id',true),''));

CREATE FUNCTION app.redispatch_failed_outbox_event(
  p_command_id uuid,
  p_workspace_id uuid,
  p_outbox_event_id uuid,
  p_actor_ref varchar,
  p_reason varchar,
  p_dry_run boolean
) RETURNS TABLE(
  command_id uuid,
  command_status varchar,
  command_outcome varchar,
  replayed boolean
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  v_existing app.operator_commands%ROWTYPE;
  v_fingerprint char(64);
  v_outbox app.outbox_events%ROWTYPE;
  v_outcome varchar(32);
  v_prior_workspace text:=current_setting('app.workspace_id',true);
BEGIN
  IF p_actor_ref IS NULL OR p_actor_ref!~'^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$' THEN
    RAISE EXCEPTION 'operator actor reference is invalid' USING ERRCODE='22023';
  END IF;
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'operator reason is invalid' USING ERRCODE='22023';
  END IF;

  v_fingerprint:=encode(sha256(convert_to(jsonb_build_object(
    'actorRef',p_actor_ref,
    'commandType','outbox.redispatch',
    'dryRun',p_dry_run,
    'outboxEventId',p_outbox_event_id,
    'reason',p_reason,
    'workspaceId',p_workspace_id
  )::text,'UTF8')),'hex');

  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_command_id::text,7166118813));
  SELECT * INTO v_existing FROM app.operator_commands WHERE id=p_command_id;
  IF FOUND THEN
    v_outcome:=CASE WHEN v_existing.request_fingerprint=v_fingerprint
      THEN v_existing.outcome ELSE 'conflict' END;
    INSERT INTO app.audit_events(
      id,workspace_id,action,target_type,target_id,request_id,metadata
    ) VALUES(
      gen_random_uuid(),p_workspace_id,'operator.outbox_redispatch',
      'outbox-event',p_outbox_event_id,p_command_id::text,
      jsonb_build_object(
        'actorRef',p_actor_ref,'dryRun',p_dry_run,'outcome',v_outcome,
        'reason',p_reason,'replayed',true,'requestFingerprint',v_fingerprint
      )
    );
    PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
    RETURN QUERY SELECT v_existing.id,v_existing.status,v_outcome,true;
    RETURN;
  END IF;

  SELECT * INTO v_outbox FROM app.outbox_events
    WHERE id=p_outbox_event_id AND workspace_id=p_workspace_id FOR UPDATE;

  v_outcome:=CASE
    WHEN NOT FOUND THEN 'not_found'
    WHEN v_outbox.published_at IS NOT NULL THEN 'already_published'
    WHEN v_outbox.failed_at IS NULL THEN 'not_failed'
    WHEN p_dry_run THEN 'would_redispatch'
    ELSE 'redispatched'
  END;

  IF v_outcome='redispatched' THEN
    UPDATE app.outbox_events SET
      available_at=clock_timestamp(),
      lease_owner=NULL,
      lease_token=NULL,
      lease_expires_at=NULL,
      publish_attempts=0,
      failed_at=NULL,
      last_error_code=NULL,
      updated_at=clock_timestamp()
    WHERE id=p_outbox_event_id AND workspace_id=p_workspace_id;
  END IF;

  INSERT INTO app.operator_commands(
    id,command_type,dry_run,request_fingerprint,status,outcome,
    prior_publish_attempts,prior_failed_at,prior_error_code
  ) VALUES(
    p_command_id,'outbox.redispatch',p_dry_run,v_fingerprint,'completed',v_outcome,
    v_outbox.publish_attempts,v_outbox.failed_at,v_outbox.last_error_code
  );

  INSERT INTO app.audit_events(
    id,workspace_id,action,target_type,target_id,request_id,metadata
  ) VALUES(
    gen_random_uuid(),p_workspace_id,'operator.outbox_redispatch',
    'outbox-event',p_outbox_event_id,p_command_id::text,
    jsonb_build_object(
      'actorRef',p_actor_ref,
      'dryRun',p_dry_run,
      'outcome',v_outcome,
      'priorErrorCode',v_outbox.last_error_code,
      'priorFailedAt',v_outbox.failed_at,
      'priorPublishAttempts',v_outbox.publish_attempts,
      'reason',p_reason,
      'requestFingerprint',v_fingerprint
    )
  );

  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN QUERY SELECT p_command_id,'completed'::varchar,v_outcome,false;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

CREATE FUNCTION app.get_operator_command(
  p_command_id uuid,
  p_workspace_id uuid,
  p_actor_ref varchar,
  p_reason varchar
)
RETURNS TABLE(
  command_id uuid,
  command_type varchar,
  dry_run boolean,
  request_fingerprint char(64),
  command_status varchar,
  command_outcome varchar,
  prior_publish_attempts integer,
  prior_failed_at timestamptz,
  prior_error_code varchar,
  created_at timestamptz,
  completed_at timestamptz
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app SET row_security=on AS $$
DECLARE
  v_prior_workspace text:=current_setting('app.workspace_id',true);
  v_found boolean;
BEGIN
  IF p_actor_ref IS NULL OR p_actor_ref!~'^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$' THEN
    RAISE EXCEPTION 'operator actor reference is invalid' USING ERRCODE='22023';
  END IF;
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'operator reason is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.workspace_id',p_workspace_id::text,true);
  SELECT EXISTS(
    SELECT 1 FROM app.operator_commands command
    WHERE command.id=p_command_id AND EXISTS(
      SELECT 1 FROM app.audit_events audit
      WHERE audit.workspace_id=p_workspace_id
        AND audit.action='operator.outbox_redispatch'
        AND audit.request_id=p_command_id::text
        AND NOT (audit.metadata?'replayed')
    )
  )
    INTO v_found;
  INSERT INTO app.audit_events(
    id,workspace_id,action,target_type,target_id,request_id,metadata
  ) VALUES(
    gen_random_uuid(),p_workspace_id,'operator.command_status','operator-command',
    p_command_id,gen_random_uuid()::text,jsonb_build_object(
      'actorRef',p_actor_ref,'found',v_found,'reason',p_reason
    )
  );
  RETURN QUERY SELECT command.id,command.command_type,
    command.dry_run,command.request_fingerprint,
    command.status,command.outcome,
    command.prior_publish_attempts,command.prior_failed_at,
    command.prior_error_code,command.created_at,
    command.completed_at
    FROM app.operator_commands command
    WHERE command.id=p_command_id AND v_found;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END;
$$;

REVOKE ALL ON app.operator_commands FROM PUBLIC;
REVOKE ALL ON FUNCTION app.redispatch_failed_outbox_event(
  uuid,uuid,uuid,varchar,varchar,boolean
) FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
  {{maintenance_role}},{{lifecycle_command_role}};
REVOKE ALL ON FUNCTION app.get_operator_command(uuid,uuid,varchar,varchar)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
  {{maintenance_role}},{{lifecycle_command_role}};

GRANT USAGE ON SCHEMA app TO {{operator_role}};
GRANT EXECUTE ON FUNCTION app.redispatch_failed_outbox_event(
  uuid,uuid,uuid,varchar,varchar,boolean
) TO {{operator_role}};
GRANT EXECUTE ON FUNCTION app.get_operator_command(uuid,uuid,varchar,varchar)
  TO {{operator_role}};
