ALTER TABLE app.workflow_runs
  ADD COLUMN failure_notification_policy_version smallint,
  ADD COLUMN failure_notification_destination_id uuid,
  ADD COLUMN failure_notification_destination_config_version integer,
  ADD COLUMN failure_notification_side_effect_class varchar(32),
  ADD CONSTRAINT workflow_runs_failure_notification_policy_complete CHECK (
    (failure_notification_policy_version IS NULL
      AND failure_notification_destination_id IS NULL
      AND failure_notification_destination_config_version IS NULL
      AND failure_notification_side_effect_class IS NULL)
    OR
    (failure_notification_policy_version = 1
      AND failure_notification_destination_id IS NOT NULL
      AND failure_notification_destination_config_version > 0
      AND failure_notification_side_effect_class IN ('safe', 'idempotent_with_key', 'unsafe'))
  );

CREATE TABLE app.run_failure_notification_intents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  workflow_run_id uuid NOT NULL,
  terminal_event_sequence integer NOT NULL,
  policy_version smallint NOT NULL,
  destination_id uuid NOT NULL,
  destination_config_version integer NOT NULL,
  side_effect_class varchar(32) NOT NULL,
  context jsonb NOT NULL,
  context_checksum char(64) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'pending',
  delivery_attempts integer NOT NULL DEFAULT 0,
  dispatch_marked_at timestamptz,
  recovery_at timestamptz,
  next_delivery_at timestamptz,
  safe_error_code varchar(128),
  possibly_dispatched boolean,
  provider_reference varchar(256),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT run_failure_notification_intents_workspace_identity_unique
    UNIQUE (workspace_id, id),
  CONSTRAINT run_failure_notification_intents_logical_unique
    UNIQUE (workflow_run_id, terminal_event_sequence, policy_version),
  CONSTRAINT run_failure_notification_intents_run_workspace_fk
    FOREIGN KEY (workspace_id, workflow_run_id)
    REFERENCES app.workflow_runs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT run_failure_notification_intents_sequence_positive
    CHECK (terminal_event_sequence > 0),
  CONSTRAINT run_failure_notification_intents_policy_supported
    CHECK (policy_version = 1),
  CONSTRAINT run_failure_notification_intents_destination_version_positive
    CHECK (destination_config_version > 0),
  CONSTRAINT run_failure_notification_intents_side_effect_class_valid
    CHECK (side_effect_class IN ('safe', 'idempotent_with_key', 'unsafe')),
  CONSTRAINT run_failure_notification_intents_context_object
    CHECK (jsonb_typeof(context) = 'object'),
  CONSTRAINT run_failure_notification_intents_context_bounded
    CHECK (octet_length(context::text) <= 4096),
  CONSTRAINT run_failure_notification_intents_checksum_format
    CHECK (context_checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT run_failure_notification_intents_status_valid
    CHECK (status IN ('pending', 'dispatching', 'retry', 'delivered', 'dead_letter', 'outcome_unknown')),
  CONSTRAINT run_failure_notification_intents_attempts_bounded
    CHECK (delivery_attempts BETWEEN 0 AND 10),
  CONSTRAINT run_failure_notification_intents_safe_error_code_format
    CHECK (safe_error_code IS NULL OR safe_error_code ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  CONSTRAINT run_failure_notification_intents_lifecycle_valid CHECK (
    (status = 'pending' AND delivery_attempts = 0 AND dispatch_marked_at IS NULL
      AND recovery_at IS NULL AND next_delivery_at IS NULL AND completed_at IS NULL)
    OR (status = 'dispatching' AND delivery_attempts > 0 AND dispatch_marked_at IS NOT NULL
      AND recovery_at IS NOT NULL AND next_delivery_at IS NULL AND completed_at IS NULL)
    OR (status = 'retry' AND delivery_attempts > 0 AND dispatch_marked_at IS NULL
      AND recovery_at IS NULL AND next_delivery_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('delivered', 'dead_letter', 'outcome_unknown')
      AND dispatch_marked_at IS NULL AND recovery_at IS NULL
      AND next_delivery_at IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX run_failure_notification_intents_workspace_run_idx
  ON app.run_failure_notification_intents (workspace_id, workflow_run_id, id);
CREATE INDEX run_failure_notification_intents_recovery_idx
  ON app.run_failure_notification_intents (recovery_at, id)
  WHERE status = 'dispatching';
CREATE INDEX run_failure_notification_intents_retry_idx
  ON app.run_failure_notification_intents (next_delivery_at, id)
  WHERE status = 'retry';

CREATE TABLE app.run_failure_notification_audit_facts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  notification_intent_id uuid NOT NULL,
  fact_type varchar(64) NOT NULL,
  attempt_number integer NOT NULL,
  safe_error_code varchar(128),
  possibly_dispatched boolean NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT run_failure_notification_audit_intent_workspace_fk
    FOREIGN KEY (workspace_id, notification_intent_id)
    REFERENCES app.run_failure_notification_intents (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT run_failure_notification_audit_fact_type_valid
    CHECK (fact_type IN ('intent_created', 'dispatch_marked', 'delivered', 'retry_scheduled', 'dead_lettered', 'outcome_unknown')),
  CONSTRAINT run_failure_notification_audit_attempt_nonnegative CHECK (attempt_number >= 0),
  CONSTRAINT run_failure_notification_audit_safe_error_code_format
    CHECK (safe_error_code IS NULL OR safe_error_code ~ '^[a-z][a-z0-9._:-]{0,127}$')
);
CREATE INDEX run_failure_notification_audit_workspace_intent_idx
  ON app.run_failure_notification_audit_facts
  (workspace_id, notification_intent_id, occurred_at, id);

ALTER TABLE app.run_failure_notification_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.run_failure_notification_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE app.run_failure_notification_audit_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.run_failure_notification_audit_facts FORCE ROW LEVEL SECURITY;

CREATE POLICY run_failure_notification_intents_workspace_scope
  ON app.run_failure_notification_intents FOR ALL
  TO {{api_runtime_role}}, {{worker_runtime_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));
CREATE POLICY run_failure_notification_audit_workspace_scope
  ON app.run_failure_notification_audit_facts FOR ALL
  TO {{api_runtime_role}}, {{worker_runtime_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));
CREATE POLICY run_failure_notification_intents_recovery_owner_select
  ON app.run_failure_notification_intents FOR SELECT TO {{owner_role}}
  USING (true);
CREATE POLICY run_failure_notification_intents_recovery_owner_update
  ON app.run_failure_notification_intents FOR UPDATE TO {{owner_role}}
  USING (true) WITH CHECK (true);
CREATE POLICY run_failure_notification_audit_recovery_owner_insert
  ON app.run_failure_notification_audit_facts FOR INSERT TO {{owner_role}}
  WITH CHECK (true);

REVOKE ALL ON app.run_failure_notification_intents,
  app.run_failure_notification_audit_facts
  FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
GRANT SELECT ON app.run_failure_notification_intents,
  app.run_failure_notification_audit_facts TO {{api_runtime_role}}, {{worker_runtime_role}};
GRANT INSERT ON app.run_failure_notification_intents,
  app.run_failure_notification_audit_facts TO {{worker_runtime_role}};
GRANT UPDATE (
  status, delivery_attempts, dispatch_marked_at, recovery_at, next_delivery_at,
  safe_error_code, possibly_dispatched, provider_reference, completed_at, updated_at
) ON app.run_failure_notification_intents TO {{worker_runtime_role}};
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.run_failure_notification_intents
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON app.run_failure_notification_audit_facts
  FROM {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}};

CREATE FUNCTION app.recover_due_run_failure_notifications(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  recovered integer := 0;
  candidate record;
  delivery_id uuid;
  delivery_payload jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'failure notification recovery limit must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;
  FOR candidate IN
    SELECT id, workspace_id, delivery_attempts, side_effect_class
      FROM app.run_failure_notification_intents
     WHERE status='dispatching' AND recovery_at<=clock_timestamp()
     ORDER BY recovery_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    IF candidate.side_effect_class = 'unsafe' THEN
      UPDATE app.run_failure_notification_intents
         SET status='outcome_unknown',dispatch_marked_at=NULL,recovery_at=NULL,
             possibly_dispatched=true,safe_error_code='delivery.recovery_ambiguous',
             completed_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE id=candidate.id;
      INSERT INTO app.run_failure_notification_audit_facts
        (id,workspace_id,notification_intent_id,fact_type,attempt_number,
         safe_error_code,possibly_dispatched)
      VALUES (gen_random_uuid(),candidate.workspace_id,candidate.id,
        'outcome_unknown',candidate.delivery_attempts,
        'delivery.recovery_ambiguous',true);
    ELSE
      UPDATE app.run_failure_notification_intents
         SET status='retry',dispatch_marked_at=NULL,recovery_at=NULL,
             next_delivery_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE id=candidate.id;
      delivery_id := gen_random_uuid();
      delivery_payload := jsonb_build_object(
        'notificationIntentId', candidate.id,
        'outboxEventId', delivery_id,
        'schemaVersion', 1,
        'workspaceId', candidate.workspace_id
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
    END IF;
    recovered := recovered + 1;
  END LOOP;
  RETURN recovered;
END;
$function$;
ALTER FUNCTION app.recover_due_run_failure_notifications(integer)
  OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.recover_due_run_failure_notifications(integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recover_due_run_failure_notifications(integer)
  TO {{worker_runtime_role}};
