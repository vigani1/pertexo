-- ADR 056: pause the schedules and webhooks of a workflow that keeps failing.

-- 1. Operational settings, never part of a published version: a workspace
--    default threshold and a per-workflow override or opt-out.
ALTER TABLE app.workspaces
  ADD COLUMN auto_pause_threshold smallint NOT NULL DEFAULT 10;
ALTER TABLE app.workspaces
  ADD CONSTRAINT workspaces_auto_pause_threshold_valid
    CHECK (auto_pause_threshold BETWEEN 3 AND 100) NOT VALID;

-- 2. Trigger pause state, separate from lifecycle, activation and every
--    trigger, endpoint and schedule status, so resuming restores exactly what
--    the pause stopped.
ALTER TABLE app.workflows
  ADD COLUMN auto_pause_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN auto_pause_threshold smallint,
  ADD COLUMN trigger_pause_state varchar(16) NOT NULL DEFAULT 'none',
  ADD COLUMN trigger_paused_at timestamptz,
  ADD COLUMN trigger_pause_reason varchar(32),
  ADD COLUMN trigger_pause_failures integer,
  ADD COLUMN trigger_pause_last_run_id uuid,
  ADD COLUMN trigger_pause_revision bigint NOT NULL DEFAULT 1;
ALTER TABLE app.workflows
  ADD CONSTRAINT workflows_auto_pause_threshold_valid CHECK (
    auto_pause_threshold IS NULL OR auto_pause_threshold BETWEEN 3 AND 100
  ) NOT VALID,
  ADD CONSTRAINT workflows_trigger_pause_valid CHECK (
    trigger_pause_revision>0 AND (
      (trigger_pause_state='none' AND trigger_paused_at IS NULL
        AND trigger_pause_reason IS NULL AND trigger_pause_failures IS NULL
        AND trigger_pause_last_run_id IS NULL)
      OR (trigger_pause_state='paused' AND trigger_paused_at IS NOT NULL
        AND trigger_pause_reason='consecutive_failures'
        AND trigger_pause_failures>0 AND trigger_pause_last_run_id IS NOT NULL))
  ) NOT VALID;

-- 3. Terminal outcomes of schedule- and webhook-started runs, written in the
--    run's own transaction and deleted once folded into the streak. A work
--    queue, not history: the run remains the record.
CREATE TABLE app.workflow_trigger_outcomes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  run_id uuid NOT NULL,
  counts_as_failure boolean NOT NULL,
  ended_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workflow_trigger_outcomes_run_fk
    FOREIGN KEY (workspace_id,run_id) REFERENCES app.workflow_runs(workspace_id,id)
    ON DELETE CASCADE,
  CONSTRAINT workflow_trigger_outcomes_workflow_fk
    FOREIGN KEY (workspace_id,workflow_id) REFERENCES app.workflows(workspace_id,id)
    ON DELETE CASCADE
);
CREATE UNIQUE INDEX workflow_trigger_outcomes_run_unique
  ON app.workflow_trigger_outcomes(workspace_id,run_id);
CREATE INDEX workflow_trigger_outcomes_pending_idx
  ON app.workflow_trigger_outcomes(created_at,id);
CREATE INDEX workflow_trigger_outcomes_workflow_idx
  ON app.workflow_trigger_outcomes(workspace_id,workflow_id);

-- 4. One streak per workflow: the current run of consecutive failures.
CREATE TABLE app.workflow_failure_streaks (
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  consecutive_failures integer NOT NULL CHECK (consecutive_failures>=0),
  last_run_id uuid,
  last_ended_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,workflow_id),
  CONSTRAINT workflow_failure_streaks_last_run_valid
    CHECK ((last_run_id IS NULL)=(last_ended_at IS NULL)),
  CONSTRAINT workflow_failure_streaks_workflow_fk
    FOREIGN KEY (workspace_id,workflow_id) REFERENCES app.workflows(workspace_id,id)
    ON DELETE CASCADE
);

-- 5. Row security. The owner reaches the new tables through the reviewed
--    functions below and bounded purge; the worker only inserts outcomes in
--    its tenant context.
DO $$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['workflow_trigger_outcomes','workflow_failure_streaks'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',v_table);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',v_table);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO {{owner_role}} USING (true) WITH CHECK (true)',
      v_table||'_owner_commands',v_table);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}}, {{maintenance_role}}, {{operator_role}}, {{lifecycle_command_role}}',v_table);
  END LOOP;
END $$;
CREATE POLICY workflow_trigger_outcomes_worker_insert ON app.workflow_trigger_outcomes
  FOR INSERT TO {{worker_runtime_role}}
  WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
GRANT INSERT ON app.workflow_trigger_outcomes TO {{worker_runtime_role}};

-- 6. New outcomes. A paused schedule occurrence has no run; a paused webhook
--    delivery answered 423 after its signature verified and before any run.
ALTER TABLE app.trigger_schedule_occurrences
  DROP CONSTRAINT trigger_schedule_occurrences_disposition_valid,
  ADD CONSTRAINT trigger_schedule_occurrences_disposition_valid CHECK (
    (disposition='accepted' AND workflow_run_id IS NOT NULL) OR
    (disposition IN ('skipped','paused') AND workflow_run_id IS NULL)
  ) NOT VALID;
ALTER TABLE app.webhook_trigger_deliveries
  DROP CONSTRAINT webhook_trigger_deliveries_outcome_valid,
  ADD CONSTRAINT webhook_trigger_deliveries_outcome_valid CHECK (
    (outcome='accepted' AND http_status=202 AND signature_check='verified'
      AND replay_check='new'
      AND workflow_run_id IS NOT NULL AND dedupe_kind IS NOT NULL)
    OR (outcome='replayed' AND http_status=202 AND signature_check='verified'
      AND replay_check='duplicate'
      AND workflow_run_id IS NOT NULL AND dedupe_kind IS NOT NULL)
    OR (workflow_run_id IS NULL AND (
      (outcome='authentication_failed' AND http_status=401 AND (
        (signature_check='not_checked' AND replay_check='stale_timestamp')
        OR (signature_check='mismatch' AND replay_check='not_checked')
        OR (signature_check='verified' AND replay_check='new')))
      OR (outcome='invalid_request' AND http_status=400
        AND signature_check='verified' AND replay_check='not_checked')
      OR (outcome='conflict' AND http_status=409
        AND signature_check='verified' AND replay_check='conflict')
      OR (outcome='rate_limited' AND http_status=429
        AND signature_check='verified' AND replay_check='new')
      OR (outcome='paused' AND http_status=423
        AND signature_check='verified' AND replay_check='new')))
  ) NOT VALID;

ALTER TABLE app.workspaces VALIDATE CONSTRAINT workspaces_auto_pause_threshold_valid;
ALTER TABLE app.workflows VALIDATE CONSTRAINT workflows_auto_pause_threshold_valid;
ALTER TABLE app.workflows VALIDATE CONSTRAINT workflows_trigger_pause_valid;
ALTER TABLE app.trigger_schedule_occurrences
  VALIDATE CONSTRAINT trigger_schedule_occurrences_disposition_valid;
ALTER TABLE app.webhook_trigger_deliveries
  VALIDATE CONSTRAINT webhook_trigger_deliveries_outcome_valid;

-- 7. Whether the workflow behind a claimed schedule is paused. It locks the
--    workflow row for the rest of the admission transaction, so a pause either
--    waits for this admission or is seen by it.
CREATE FUNCTION app.schedule_claim_workflow_paused(p_trigger_id uuid,p_lease_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_workspace_id uuid; v_state varchar; v_prior_workspace text;
BEGIN
  v_prior_workspace:=current_setting('app.workspace_id',true);
  SELECT trigger.workspace_id INTO v_workspace_id
    FROM app.workflow_triggers trigger WHERE trigger.id=p_trigger_id;
  IF v_workspace_id IS NULL THEN RETURN false; END IF;
  PERFORM set_config('app.workspace_id',v_workspace_id::text,true);
  SELECT workflow.trigger_pause_state INTO v_state
    FROM app.trigger_schedules schedule
    JOIN app.workflow_triggers trigger ON trigger.id=schedule.trigger_id
    JOIN app.workflows workflow ON workflow.workspace_id=trigger.workspace_id
     AND workflow.id=trigger.workflow_id
   WHERE schedule.trigger_id=p_trigger_id AND schedule.lease_token=p_lease_token
     AND schedule.lease_expires_at>clock_timestamp()
   FOR SHARE OF workflow;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RETURN coalesce(v_state='paused',false);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

-- 8. Fold pending outcomes into streaks and pause workflows that reach their
--    threshold. Disjoint batches under SKIP LOCKED; each workflow's outcomes
--    applied in end order under its streak row lock; outcomes deleted in the
--    same transaction, so each counts once and a burst pauses exactly once.
--    With p_enforce false the fold reports would-pause workflows unchanged.
CREATE FUNCTION app.fold_workflow_trigger_outcomes(p_limit integer,p_enforce boolean)
RETURNS TABLE(workspace_id uuid,workflow_id uuid,consecutive_failures integer,paused boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
#variable_conflict use_column
DECLARE
  v_batch jsonb; v_group record; v_prior_workspace text; v_streak integer;
  v_threshold integer; v_enabled boolean; v_lifecycle varchar; v_state varchar;
  v_workspace_status varchar; v_reached_run uuid; v_reached_count integer;
  v_index integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'trigger outcome fold limit must be between 1 and 1000' USING ERRCODE='22023';
  END IF;
  IF p_enforce IS NULL THEN
    RAISE EXCEPTION 'trigger outcome fold mode is required' USING ERRCODE='22023';
  END IF;
  v_prior_workspace:=current_setting('app.workspace_id',true);
  WITH picked AS MATERIALIZED (
    SELECT outcome.id,outcome.workspace_id,outcome.workflow_id,outcome.run_id,
           outcome.counts_as_failure,outcome.ended_at
      FROM app.workflow_trigger_outcomes outcome
     ORDER BY outcome.created_at,outcome.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  ), consumed AS (
    DELETE FROM app.workflow_trigger_outcomes outcome USING picked
     WHERE outcome.id=picked.id
    RETURNING picked.id,picked.workspace_id,picked.workflow_id,picked.run_id,
              picked.counts_as_failure,picked.ended_at
  )
  SELECT coalesce(jsonb_agg(to_jsonb(consumed)),'[]'::jsonb) INTO v_batch FROM consumed;

  FOR v_group IN
    SELECT batch.workspace_id,batch.workflow_id,
           array_agg(batch.counts_as_failure ORDER BY batch.ended_at,batch.id) AS failures,
           array_agg(batch.run_id ORDER BY batch.ended_at,batch.id) AS runs,
           array_agg(batch.ended_at ORDER BY batch.ended_at,batch.id) AS ended
      FROM jsonb_to_recordset(v_batch) AS batch(
        id uuid,workspace_id uuid,workflow_id uuid,run_id uuid,
        counts_as_failure boolean,ended_at timestamptz)
     GROUP BY batch.workspace_id,batch.workflow_id
     ORDER BY batch.workspace_id,batch.workflow_id
  LOOP
    PERFORM set_config('app.workspace_id',v_group.workspace_id::text,true);
    SELECT workflow.auto_pause_enabled,workflow.lifecycle_status,
           workflow.trigger_pause_state,workspace.status,
           coalesce(workflow.auto_pause_threshold,workspace.auto_pause_threshold)
      INTO v_enabled,v_lifecycle,v_state,v_workspace_status,v_threshold
      FROM app.workflows workflow
      JOIN app.workspaces workspace ON workspace.id=workflow.workspace_id
     WHERE workflow.workspace_id=v_group.workspace_id
       AND workflow.id=v_group.workflow_id;
    -- A workflow removed since its runs ended has nothing left to pause.
    CONTINUE WHEN NOT FOUND;

    INSERT INTO app.workflow_failure_streaks AS streak
      (workspace_id,workflow_id,consecutive_failures)
    VALUES (v_group.workspace_id,v_group.workflow_id,0)
    ON CONFLICT ON CONSTRAINT workflow_failure_streaks_pkey DO NOTHING;
    SELECT streak.consecutive_failures INTO v_streak
      FROM app.workflow_failure_streaks streak
     WHERE streak.workspace_id=v_group.workspace_id
       AND streak.workflow_id=v_group.workflow_id
       FOR UPDATE;

    v_reached_run:=NULL;
    v_reached_count:=NULL;
    FOR v_index IN 1..cardinality(v_group.failures) LOOP
      IF v_group.failures[v_index] THEN
        v_streak:=v_streak+1;
        IF v_streak>=v_threshold AND v_reached_run IS NULL THEN
          v_reached_run:=v_group.runs[v_index];
          v_reached_count:=v_streak;
        END IF;
      ELSE
        v_streak:=0;
      END IF;
    END LOOP;

    UPDATE app.workflow_failure_streaks streak
       SET consecutive_failures=v_streak,
           last_run_id=v_group.runs[cardinality(v_group.runs)],
           last_ended_at=v_group.ended[cardinality(v_group.ended)],
           updated_at=clock_timestamp()
     WHERE streak.workspace_id=v_group.workspace_id
       AND streak.workflow_id=v_group.workflow_id;

    IF v_reached_run IS NOT NULL AND v_enabled AND v_lifecycle='active'
       AND v_state='none' AND v_workspace_status='active' THEN
      IF p_enforce THEN
        UPDATE app.workflows workflow
           SET trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),
               trigger_pause_reason='consecutive_failures',
               trigger_pause_failures=v_reached_count,
               trigger_pause_last_run_id=v_reached_run,
               trigger_pause_revision=workflow.trigger_pause_revision+1
         WHERE workflow.workspace_id=v_group.workspace_id
           AND workflow.id=v_group.workflow_id
           AND workflow.trigger_pause_state='none';
        IF FOUND THEN
          INSERT INTO app.audit_events(id,workspace_id,action,target_type,target_id,metadata)
          VALUES (gen_random_uuid(),v_group.workspace_id,'workflow.triggers_paused',
            'workflow',v_group.workflow_id,
            jsonb_build_object('reason','consecutive_failures',
              'failures',v_reached_count,'threshold',v_threshold,
              'lastRunId',v_reached_run));
          workspace_id:=v_group.workspace_id;
          workflow_id:=v_group.workflow_id;
          consecutive_failures:=v_reached_count;
          paused:=true;
          RETURN NEXT;
        END IF;
      ELSE
        workspace_id:=v_group.workspace_id;
        workflow_id:=v_group.workflow_id;
        consecutive_failures:=v_reached_count;
        paused:=false;
        RETURN NEXT;
      END IF;
    END IF;
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(v_prior_workspace,''),true);
  RAISE;
END $$;

ALTER FUNCTION app.schedule_claim_workflow_paused(uuid,uuid) OWNER TO {{owner_role}};
ALTER FUNCTION app.fold_workflow_trigger_outcomes(integer,boolean) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.schedule_claim_workflow_paused(uuid,uuid),
  app.fold_workflow_trigger_outcomes(integer,boolean)
  FROM PUBLIC,{{api_runtime_role}},{{dispatcher_role}},{{maintenance_role}},
    {{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.schedule_claim_workflow_paused(uuid,uuid),
  app.fold_workflow_trigger_outcomes(integer,boolean)
  TO {{worker_runtime_role}};
GRANT EXECUTE ON FUNCTION app.schedule_claim_workflow_paused(uuid,uuid)
  TO {{api_runtime_role}};

-- 9. Workspace purge removes the new tables before workflow runs. The marker
--    must occur exactly once.
DO $$
DECLARE v_definition text; v_marker text; v_matches integer;
BEGIN
  SELECT pg_get_functiondef('app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)'::regprocedure)
    INTO v_definition;
  v_marker:='''workspace_inbox_events'', ''workflow_runs''';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN
    RAISE EXCEPTION 'workspace tenant purge function shape is incompatible (% matches)',v_matches;
  END IF;
  EXECUTE replace(v_definition,v_marker,
    '''workspace_inbox_events'', ''workflow_failure_streaks'', ''workflow_trigger_outcomes'', ''workflow_runs''');
END $$;
