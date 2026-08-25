CREATE TABLE app.failure_notification_destinations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  kind varchar(16) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'enabled',
  current_config_version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT failure_notification_destinations_workspace_identity_unique UNIQUE (workspace_id, id),
  CONSTRAINT failure_notification_destinations_workspace_identity_kind_unique UNIQUE (workspace_id, id, kind),
  CONSTRAINT failure_notification_destinations_workspace_fk FOREIGN KEY (workspace_id)
    REFERENCES app.workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT failure_notification_destinations_creator_fk FOREIGN KEY (created_by)
    REFERENCES app.users(id) ON DELETE RESTRICT,
  CONSTRAINT failure_notification_destinations_kind_valid CHECK (kind IN ('slack', 'email')),
  CONSTRAINT failure_notification_destinations_status_valid CHECK (status IN ('enabled', 'disabled')),
  CONSTRAINT failure_notification_destinations_version_positive CHECK (current_config_version > 0)
);

CREATE TABLE app.failure_notification_destination_versions (
  workspace_id uuid NOT NULL,
  destination_id uuid NOT NULL,
  version integer NOT NULL,
  kind varchar(16) NOT NULL,
  side_effect_class varchar(32) NOT NULL,
  config jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (destination_id, version),
  CONSTRAINT failure_notification_destination_versions_workspace_identity_unique
    UNIQUE (workspace_id, destination_id, version),
  CONSTRAINT failure_notification_destination_versions_workspace_identity_effect_unique
    UNIQUE (workspace_id, destination_id, version, side_effect_class),
  CONSTRAINT failure_notification_destination_versions_destination_kind_fk
    FOREIGN KEY (workspace_id, destination_id, kind)
    REFERENCES app.failure_notification_destinations(workspace_id, id, kind) ON DELETE RESTRICT,
  CONSTRAINT failure_notification_destination_versions_creator_fk FOREIGN KEY (created_by)
    REFERENCES app.users(id) ON DELETE RESTRICT,
  CONSTRAINT failure_notification_destination_versions_version_positive CHECK (version > 0),
  CONSTRAINT failure_notification_destination_versions_kind_valid CHECK (kind IN ('slack', 'email')),
  CONSTRAINT failure_notification_destination_versions_side_effect_valid CHECK (
    (kind = 'slack' AND side_effect_class = 'unsafe') OR
    (kind = 'email' AND side_effect_class = 'idempotent_with_key')
  ),
  CONSTRAINT failure_notification_destination_versions_config_strict CHECK (
    jsonb_typeof(config) = 'object' AND
    ((kind = 'slack' AND config ? 'connectionId' AND config ? 'channelId'
      AND (config - 'connectionId' - 'channelId') = '{}'::jsonb
      AND (config->>'connectionId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND (config->>'channelId') ~ '^[CDGU][A-Z0-9]{1,79}$')
     OR
     (kind = 'email' AND config ? 'connectionId' AND config ? 'toEmail'
      AND (config - 'connectionId' - 'toEmail') = '{}'::jsonb
      AND (config->>'connectionId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND length(config->>'toEmail') BETWEEN 3 AND 254
      AND (config->>'toEmail') ~ '^[!-~]+@[A-Za-z0-9.-]+$'))
  )
);

ALTER TABLE app.failure_notification_destinations
  ADD CONSTRAINT failure_notification_destinations_current_version_fk
  FOREIGN KEY (workspace_id, id, current_config_version)
  REFERENCES app.failure_notification_destination_versions(workspace_id, destination_id, version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.workflow_failure_notification_policies (
  workspace_id uuid NOT NULL,
  workflow_id uuid PRIMARY KEY,
  destination_id uuid NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workflow_failure_notification_policies_workspace_workflow_unique UNIQUE (workspace_id, workflow_id),
  CONSTRAINT workflow_failure_notification_policies_workflow_fk FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES app.workflows(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_failure_notification_policies_destination_fk FOREIGN KEY (workspace_id, destination_id)
    REFERENCES app.failure_notification_destinations(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT workflow_failure_notification_policies_updater_fk FOREIGN KEY (updated_by)
    REFERENCES app.users(id) ON DELETE RESTRICT
);

ALTER TABLE app.workflow_runs
  ADD COLUMN failure_notification_connection_secret_version_id uuid,
  ADD CONSTRAINT workflow_runs_failure_notification_destination_version_fk
    FOREIGN KEY (workspace_id, failure_notification_destination_id,
                 failure_notification_destination_config_version)
    REFERENCES app.failure_notification_destination_versions
      (workspace_id, destination_id, version) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT workflow_runs_failure_notification_pin_unique UNIQUE (
    workspace_id, id, failure_notification_policy_version,
    failure_notification_destination_id,
    failure_notification_destination_config_version,
    failure_notification_side_effect_class,
    failure_notification_connection_secret_version_id
  ),
  DROP CONSTRAINT workflow_runs_failure_notification_policy_complete,
  ADD CONSTRAINT workflow_runs_failure_notification_policy_complete CHECK (
    (failure_notification_policy_version IS NULL
      AND failure_notification_destination_id IS NULL
      AND failure_notification_destination_config_version IS NULL
      AND failure_notification_side_effect_class IS NULL
      AND failure_notification_connection_secret_version_id IS NULL)
    OR
    (failure_notification_policy_version = 1
      AND failure_notification_destination_id IS NOT NULL
      AND failure_notification_destination_config_version > 0
      AND failure_notification_side_effect_class IN ('safe', 'idempotent_with_key', 'unsafe'))
  );

ALTER TABLE app.run_failure_notification_intents
  ADD COLUMN connection_secret_version_id uuid,
  ADD COLUMN delivery_binding varchar(128),
  DROP CONSTRAINT run_failure_notification_intents_status_valid,
  DROP CONSTRAINT run_failure_notification_intents_lifecycle_valid;

-- Pre-0037 intents cannot name a real immutable destination or secret. Quarantine
-- only their delivery state; completed run and historical terminal intent truth
-- remains unchanged.
WITH quarantined AS (
  UPDATE app.run_failure_notification_intents intent
     SET status=CASE WHEN intent.status='dispatching'
           THEN 'outcome_unknown' ELSE 'dead_letter' END,
         dispatch_marked_at=NULL, recovery_at=NULL, next_delivery_at=NULL,
         safe_error_code=CASE WHEN intent.status='dispatching'
           THEN 'delivery.recovery_ambiguous' ELSE 'delivery.destination_unavailable' END,
         possibly_dispatched=(intent.status='dispatching'),
         completed_at=coalesce(completed_at,clock_timestamp()),
         updated_at=clock_timestamp()
   WHERE status IN ('pending','retry','dispatching')
     AND (connection_secret_version_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM app.failure_notification_destination_versions version
        WHERE version.workspace_id=intent.workspace_id
          AND version.destination_id=intent.destination_id
          AND version.version=intent.destination_config_version
          AND version.side_effect_class=intent.side_effect_class
     ))
  RETURNING workspace_id,id,delivery_attempts,status,safe_error_code,possibly_dispatched
)
INSERT INTO app.run_failure_notification_audit_facts (
  id,workspace_id,notification_intent_id,fact_type,attempt_number,
  safe_error_code,possibly_dispatched
)
SELECT gen_random_uuid(),workspace_id,id,
       CASE WHEN status='outcome_unknown' THEN 'outcome_unknown' ELSE 'dead_lettered' END,
       delivery_attempts,safe_error_code,possibly_dispatched
  FROM quarantined
 WHERE NOT EXISTS (
   SELECT 1 FROM app.run_failure_notification_audit_facts audit
    WHERE audit.workspace_id=quarantined.workspace_id
      AND audit.notification_intent_id=quarantined.id
      AND audit.fact_type=CASE WHEN quarantined.status='outcome_unknown'
        THEN 'outcome_unknown' ELSE 'dead_lettered' END
      AND audit.safe_error_code=quarantined.safe_error_code
 );

ALTER TABLE app.run_failure_notification_intents
  ADD CONSTRAINT run_failure_notification_intents_destination_version_fk
    FOREIGN KEY (workspace_id, destination_id, destination_config_version)
    REFERENCES app.failure_notification_destination_versions
      (workspace_id, destination_id, version) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT run_failure_notification_intents_run_pin_fk FOREIGN KEY (
    workspace_id, workflow_run_id, policy_version, destination_id,
    destination_config_version, side_effect_class, connection_secret_version_id
  ) REFERENCES app.workflow_runs (
    workspace_id, id, failure_notification_policy_version,
    failure_notification_destination_id,
    failure_notification_destination_config_version,
    failure_notification_side_effect_class,
    failure_notification_connection_secret_version_id
  ) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT run_failure_notification_intents_delivery_binding_format CHECK (
    delivery_binding IS NULL OR delivery_binding ~ '^email:v1:sha256:[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT run_failure_notification_intents_status_valid CHECK (
    status IN ('pending','claimed','dispatching','retry','delivered','dead_letter','outcome_unknown')
  ),
  ADD CONSTRAINT run_failure_notification_intents_lifecycle_valid CHECK (
    (status='pending' AND delivery_attempts=0 AND dispatch_marked_at IS NULL
      AND recovery_at IS NULL AND next_delivery_at IS NULL AND completed_at IS NULL)
    OR (status='claimed' AND delivery_attempts>0 AND dispatch_marked_at IS NULL
      AND recovery_at IS NOT NULL AND next_delivery_at IS NULL AND completed_at IS NULL)
    OR (status='dispatching' AND delivery_attempts>0 AND dispatch_marked_at IS NOT NULL
      AND recovery_at IS NOT NULL AND next_delivery_at IS NULL AND completed_at IS NULL)
    OR (status='retry' AND delivery_attempts>0 AND dispatch_marked_at IS NULL
      AND recovery_at IS NULL AND next_delivery_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('delivered','dead_letter','outcome_unknown')
      AND dispatch_marked_at IS NULL AND recovery_at IS NULL
      AND next_delivery_at IS NULL AND completed_at IS NOT NULL)
  );

CREATE INDEX failure_notification_destinations_workspace_status_idx
  ON app.failure_notification_destinations(workspace_id, status, created_at, id);
CREATE INDEX failure_notification_destination_versions_workspace_idx
  ON app.failure_notification_destination_versions(workspace_id, destination_id, version DESC);
CREATE INDEX workflow_failure_notification_policies_destination_idx
  ON app.workflow_failure_notification_policies(workspace_id, destination_id, workflow_id);
DROP INDEX app.run_failure_notification_intents_recovery_idx;
CREATE INDEX run_failure_notification_intents_recovery_idx
  ON app.run_failure_notification_intents(recovery_at,id)
  WHERE status IN ('claimed','dispatching');

CREATE FUNCTION app.reject_failure_notification_destination_version_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'failure notification destination versions are immutable' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER failure_notification_destination_versions_immutable
  BEFORE UPDATE OR DELETE ON app.failure_notification_destination_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_failure_notification_destination_version_mutation();

CREATE FUNCTION app.validate_workflow_run_failure_notification_pin()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  configured_connection_id uuid;
  pin_valid boolean;
BEGIN
  IF NEW.failure_notification_policy_version IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT CASE
    WHEN jsonb_typeof(version.config)='object'
      AND version.config ? 'connectionId'
      AND (version.config->>'connectionId') ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN (version.config->>'connectionId')::uuid
    ELSE NULL
  END
  INTO configured_connection_id
  FROM app.failure_notification_destinations destination
  JOIN app.failure_notification_destination_versions version
    ON version.workspace_id=destination.workspace_id
   AND version.destination_id=destination.id
   AND version.version=NEW.failure_notification_destination_config_version
  WHERE destination.workspace_id=NEW.workspace_id
    AND destination.id=NEW.failure_notification_destination_id
    AND destination.current_config_version=version.version
    AND destination.status='enabled'
    AND version.kind=destination.kind
    AND version.side_effect_class=NEW.failure_notification_side_effect_class
    AND ((version.kind='slack' AND version.side_effect_class='unsafe')
      OR (version.kind='email' AND version.side_effect_class='idempotent_with_key'))
  FOR SHARE OF destination;

  IF configured_connection_id IS NOT NULL THEN
    SELECT true INTO pin_valid
    FROM app.workspaces workspace
    JOIN app.connections connection
      ON connection.workspace_id=workspace.id
     AND connection.id=configured_connection_id
    JOIN app.connection_secret_versions secret
      ON secret.workspace_id=connection.workspace_id
     AND secret.connection_id=connection.id
     AND secret.id=NEW.failure_notification_connection_secret_version_id
    WHERE workspace.id=NEW.workspace_id
      AND workspace.status='active'
      AND connection.status='active'
      AND connection.current_secret_version_id=secret.id
      AND ((NEW.failure_notification_side_effect_class='unsafe'
            AND connection.provider_key='slack'
            AND connection.auth_type='slack_bot_token')
        OR (NEW.failure_notification_side_effect_class='idempotent_with_key'
            AND connection.provider_key='email'
            AND connection.auth_type='resend_api_key'))
    FOR SHARE OF workspace,connection;
  END IF;

  IF coalesce(pin_valid,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'new failure notification policy pin is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_runs_require_new_failure_notification_pin
  BEFORE INSERT OR UPDATE OF failure_notification_policy_version,
    failure_notification_destination_id,
    failure_notification_destination_config_version,
    failure_notification_side_effect_class,
    failure_notification_connection_secret_version_id
  ON app.workflow_runs FOR EACH ROW
  EXECUTE FUNCTION app.validate_workflow_run_failure_notification_pin();

CREATE FUNCTION app.require_new_failure_notification_intent_pin()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.connection_secret_version_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM app.workflow_runs run
     WHERE run.workspace_id=NEW.workspace_id
       AND run.id=NEW.workflow_run_id
       AND run.failure_notification_policy_version=NEW.policy_version
       AND run.failure_notification_destination_id=NEW.destination_id
       AND run.failure_notification_destination_config_version=NEW.destination_config_version
       AND run.failure_notification_side_effect_class=NEW.side_effect_class
       AND run.failure_notification_connection_secret_version_id=NEW.connection_secret_version_id
  ) THEN
    RAISE EXCEPTION 'new failure notification intent must exactly match its run pin'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER run_failure_notification_intents_require_run_pin
  BEFORE INSERT OR UPDATE OF workspace_id,workflow_run_id,policy_version,
    destination_id,destination_config_version,side_effect_class,
    connection_secret_version_id
  ON app.run_failure_notification_intents FOR EACH ROW
  EXECUTE FUNCTION app.require_new_failure_notification_intent_pin();

DROP FUNCTION app.recover_due_run_failure_notifications(integer);
CREATE FUNCTION app.recover_due_run_failure_notifications(
  p_limit integer,
  p_max_attempts integer
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  recovered integer := 0;
  candidate record;
  terminal_status text;
  error_code text;
  delivery_id uuid;
  delivery_payload jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR
     p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 10 THEN
    RAISE EXCEPTION 'invalid failure notification recovery bounds' USING ERRCODE = '22023';
  END IF;
  FOR candidate IN
    SELECT id,workspace_id,status,delivery_attempts,side_effect_class,
           coalesce(possibly_dispatched,false) delivery_unresolved
      FROM app.run_failure_notification_intents
     WHERE status IN ('claimed','dispatching') AND recovery_at<=clock_timestamp()
     ORDER BY recovery_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    IF candidate.status='dispatching' AND candidate.side_effect_class='unsafe' THEN
      terminal_status := 'outcome_unknown';
      error_code := 'delivery.recovery_ambiguous';
    ELSIF candidate.delivery_attempts >= p_max_attempts THEN
      IF candidate.side_effect_class='idempotent_with_key' AND
         (candidate.delivery_unresolved OR candidate.status='dispatching') THEN
        terminal_status := 'outcome_unknown';
        error_code := 'delivery.attempts_exhausted_unknown';
      ELSE
        terminal_status := 'dead_letter';
        error_code := 'delivery.attempts_exhausted';
      END IF;
    ELSE
      terminal_status := NULL;
      error_code := CASE WHEN candidate.status='dispatching'
        THEN 'delivery.recovery_ambiguous' ELSE 'delivery.recovery_predispatch' END;
    END IF;

    IF terminal_status IS NOT NULL THEN
      UPDATE app.run_failure_notification_intents
         SET status=terminal_status,dispatch_marked_at=NULL,recovery_at=NULL,
             next_delivery_at=NULL,safe_error_code=error_code,
             possibly_dispatched=(candidate.delivery_unresolved OR candidate.status='dispatching'),
             completed_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE id=candidate.id;
      INSERT INTO app.run_failure_notification_audit_facts
        (id,workspace_id,notification_intent_id,fact_type,attempt_number,
         safe_error_code,possibly_dispatched)
      VALUES (gen_random_uuid(),candidate.workspace_id,candidate.id,
        CASE WHEN terminal_status='outcome_unknown' THEN 'outcome_unknown' ELSE 'dead_lettered' END,
        candidate.delivery_attempts,error_code,
        candidate.delivery_unresolved OR candidate.status='dispatching');
    ELSE
      UPDATE app.run_failure_notification_intents
         SET status='retry',dispatch_marked_at=NULL,recovery_at=NULL,
             next_delivery_at=clock_timestamp(),safe_error_code=error_code,
             possibly_dispatched=(candidate.delivery_unresolved OR candidate.status='dispatching'),
             updated_at=clock_timestamp()
       WHERE id=candidate.id;
      delivery_id := gen_random_uuid();
      delivery_payload := jsonb_build_object(
        'notificationIntentId',candidate.id,'outboxEventId',delivery_id,
        'schemaVersion',1,'workspaceId',candidate.workspace_id
      );
      INSERT INTO app.outbox_events (
        id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,
        payload,payload_checksum
      ) VALUES (
        delivery_id,candidate.workspace_id,'deliver-run-failure-notification',1,
        'run-failure-notification',candidate.id,delivery_payload,
        encode(sha256(convert_to(
          '{"notificationIntentId":"' || candidate.id::text ||
          '","outboxEventId":"' || delivery_id::text ||
          '","schemaVersion":1,"workspaceId":"' ||
          candidate.workspace_id::text || '"}', 'UTF8')),'hex')
      );
      INSERT INTO app.run_failure_notification_audit_facts
        (id,workspace_id,notification_intent_id,fact_type,attempt_number,
         safe_error_code,possibly_dispatched)
      VALUES (gen_random_uuid(),candidate.workspace_id,candidate.id,
        'retry_scheduled',candidate.delivery_attempts,error_code,
        candidate.delivery_unresolved OR candidate.status='dispatching');
    END IF;
    recovered := recovered + 1;
  END LOOP;
  RETURN recovered;
END;
$function$;
ALTER FUNCTION app.recover_due_run_failure_notifications(integer,integer)
  OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.recover_due_run_failure_notifications(integer,integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recover_due_run_failure_notifications(integer,integer)
  TO {{worker_runtime_role}};

ALTER TABLE app.failure_notification_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.failure_notification_destinations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.failure_notification_destination_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.failure_notification_destination_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_failure_notification_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_failure_notification_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY failure_notification_destinations_workspace_scope
  ON app.failure_notification_destinations FOR ALL TO {{api_runtime_role}}, {{worker_runtime_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));
CREATE POLICY failure_notification_destination_versions_workspace_scope
  ON app.failure_notification_destination_versions FOR ALL TO {{api_runtime_role}}, {{worker_runtime_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));
CREATE POLICY workflow_failure_notification_policies_workspace_scope
  ON app.workflow_failure_notification_policies FOR ALL TO {{api_runtime_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));

REVOKE ALL ON app.failure_notification_destinations,
  app.failure_notification_destination_versions,
  app.workflow_failure_notification_policies
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
GRANT SELECT, INSERT ON app.failure_notification_destinations,
  app.failure_notification_destination_versions TO {{api_runtime_role}};
GRANT UPDATE (status, current_config_version, updated_at)
  ON app.failure_notification_destinations TO {{api_runtime_role}};
GRANT SELECT, INSERT, UPDATE, DELETE ON app.workflow_failure_notification_policies
  TO {{api_runtime_role}};
GRANT SELECT ON app.failure_notification_destinations,
  app.failure_notification_destination_versions TO {{worker_runtime_role}};
GRANT UPDATE (delivery_binding)
  ON app.run_failure_notification_intents TO {{worker_runtime_role}};
REVOKE UPDATE, DELETE, TRUNCATE ON app.failure_notification_destination_versions
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
