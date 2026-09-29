-- ADR 055: per-workflow failure threads read on demand. Retires ADR 054's
-- capture and fan-out machinery, which was never activated.

-- 1. Retire ADR 054 delivery objects. They must be empty: lift forced RLS so
--    the owner's count sees every row, and refuse to drop anything populated.
DO $$
DECLARE v_table text; v_rows bigint;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'workspace_inbox_entries','workspace_inbox_audience',
    'workspace_inbox_recipient_state','workspace_inbox_sources'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I NO FORCE ROW LEVEL SECURITY',v_table);
    EXECUTE format('SELECT count(*) FROM app.%I',v_table) INTO v_rows;
    IF v_rows<>0 THEN
      RAISE EXCEPTION 'inbox table % holds % rows; ADR 055 retires only unused tables',
        v_table,v_rows;
    END IF;
  END LOOP;
END $$;

DROP FUNCTION app.fail_workspace_inbox_projection(uuid,uuid,uuid,bigint);
DROP FUNCTION app.project_workspace_inbox_page(uuid,uuid,uuid,bigint);
DROP FUNCTION app.claim_workspace_inbox_projection(uuid,uuid,uuid,character,varchar,uuid);
DROP FUNCTION app.validate_workspace_inbox_delivery(uuid,uuid,uuid,character);
DROP FUNCTION app.fail_workspace_inbox_capture(uuid,uuid,uuid,bigint);
DROP FUNCTION app.capture_workspace_inbox_audience(uuid,uuid,uuid,bigint);
DROP FUNCTION app.claim_workspace_inbox_capture(uuid,uuid,uuid,character,varchar,uuid);
DROP FUNCTION app.workspace_inbox_source_checksum(uuid,uuid,bigint,varchar,timestamptz);
-- The sources policy reads entries, so it goes before either table.
DROP POLICY workspace_inbox_sources_recipient_select ON app.workspace_inbox_sources;
DROP TABLE app.workspace_inbox_entries;
DROP FUNCTION app.preserve_workspace_inbox_read_time();
DROP TABLE app.workspace_inbox_audience;
DROP TABLE app.workspace_inbox_recipient_state;
DROP TABLE app.workspace_inbox_sources;

-- 2. Pending failures: one immutable row per terminal failure, written in the
--    run's own transaction and deleted once folded into its thread. A work
--    queue, not history: the run and its events remain the record.
CREATE TABLE app.workspace_inbox_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  run_id uuid NOT NULL,
  terminal_event_sequence bigint NOT NULL CHECK (terminal_event_sequence>0),
  kind varchar(32) NOT NULL
    CHECK (kind IN ('failed','timed_out','outcome_unknown')),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_inbox_events_run_fk
    FOREIGN KEY (workspace_id,run_id) REFERENCES app.workflow_runs(workspace_id,id)
    ON DELETE CASCADE,
  CONSTRAINT workspace_inbox_events_workflow_fk
    FOREIGN KEY (workspace_id,workflow_id) REFERENCES app.workflows(workspace_id,id)
    ON DELETE CASCADE
);
CREATE UNIQUE INDEX workspace_inbox_events_terminal_unique
  ON app.workspace_inbox_events(workspace_id,run_id,terminal_event_sequence);
CREATE INDEX workspace_inbox_events_pending_idx
  ON app.workspace_inbox_events(created_at,id);
CREATE INDEX workspace_inbox_events_workflow_idx
  ON app.workspace_inbox_events(workspace_id,workflow_id);

-- 3. One thread per failing workflow, shared by the workspace's readers.
--    Revisions come from one sequence: monotonic, contention-free, compared only.
CREATE SEQUENCE app.workspace_inbox_revision_seq AS bigint MINVALUE 1;
CREATE TABLE app.workspace_inbox_threads (
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision>0),
  occurrence_count bigint NOT NULL CHECK (occurrence_count>0),
  first_occurred_at timestamptz NOT NULL,
  latest_occurred_at timestamptz NOT NULL,
  latest_run_id uuid NOT NULL,
  latest_kind varchar(32) NOT NULL
    CHECK (latest_kind IN ('failed','timed_out','outcome_unknown')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,workflow_id),
  CONSTRAINT workspace_inbox_threads_occurrence_order
    CHECK (latest_occurred_at>=first_occurred_at),
  CONSTRAINT workspace_inbox_threads_workflow_fk
    FOREIGN KEY (workspace_id,workflow_id) REFERENCES app.workflows(workspace_id,id)
    ON DELETE RESTRICT
);
CREATE INDEX workspace_inbox_threads_recent_idx
  ON app.workspace_inbox_threads(workspace_id,latest_occurred_at DESC,workflow_id DESC);
CREATE INDEX workspace_inbox_threads_expiry_idx
  ON app.workspace_inbox_threads(latest_occurred_at,workspace_id,workflow_id);

-- 4. Each reader's private state: the revision of each thread they read.
CREATE TABLE app.workspace_inbox_reads (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  read_revision bigint NOT NULL CHECK (read_revision>0),
  read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,user_id,workflow_id),
  CONSTRAINT workspace_inbox_reads_thread_fk
    FOREIGN KEY (workspace_id,workflow_id)
    REFERENCES app.workspace_inbox_threads(workspace_id,workflow_id)
    ON DELETE CASCADE,
  CONSTRAINT workspace_inbox_reads_membership_fk
    FOREIGN KEY (workspace_id,user_id)
    REFERENCES app.workspace_memberships(workspace_id,user_id)
    ON DELETE RESTRICT
);

-- A read never moves backwards, whatever a writer sends.
CREATE FUNCTION app.preserve_workspace_inbox_read_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,app AS $$
BEGIN
  IF NEW.read_revision<OLD.read_revision THEN
    NEW.read_revision:=OLD.read_revision;
    NEW.read_at:=OLD.read_at;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.preserve_workspace_inbox_read_revision() FROM PUBLIC;
CREATE TRIGGER workspace_inbox_reads_monotonic
  BEFORE UPDATE ON app.workspace_inbox_reads
  FOR EACH ROW EXECUTE FUNCTION app.preserve_workspace_inbox_read_revision();

-- 5. Row security. The owner reaches these tables only through the reviewed
--    functions below and bounded purge; API reads are recipient-checked; the
--    worker only inserts pending failures in its tenant context.
DO $$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'workspace_inbox_events','workspace_inbox_threads','workspace_inbox_reads'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',v_table);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',v_table);
    EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL TO {{owner_role}} USING (true) WITH CHECK (true)',
      v_table||'_owner_commands',v_table);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC, {{api_runtime_role}}, {{worker_runtime_role}}, {{dispatcher_role}}, {{maintenance_role}}, {{operator_role}}, {{lifecycle_command_role}}',v_table);
  END LOOP;
END $$;
CREATE POLICY workspace_inbox_events_worker_insert ON app.workspace_inbox_events
  FOR INSERT TO {{worker_runtime_role}}
  WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workspace_inbox_threads_recipient_select ON app.workspace_inbox_threads
  FOR SELECT TO {{api_runtime_role}}
  USING (
    app.workspace_inbox_recipient_eligible(workspace_id,
      NULLIF(current_setting('app.actor_id',true),'')::uuid)
    AND latest_occurred_at>statement_timestamp()-interval '720 hours');
CREATE POLICY workspace_inbox_reads_recipient_scope ON app.workspace_inbox_reads
  FOR ALL TO {{api_runtime_role}}
  USING (app.workspace_inbox_recipient_eligible(workspace_id,user_id))
  WITH CHECK (app.workspace_inbox_recipient_eligible(workspace_id,user_id));

GRANT INSERT ON app.workspace_inbox_events TO {{worker_runtime_role}};
GRANT SELECT ON app.workspace_inbox_threads TO {{api_runtime_role}};
GRANT SELECT,INSERT ON app.workspace_inbox_reads TO {{api_runtime_role}};
GRANT UPDATE (read_revision,read_at) ON app.workspace_inbox_reads TO {{api_runtime_role}};

-- 6. Fold pending failures into threads. Disjoint batches under SKIP LOCKED,
--    threads upserted in key order so concurrent folds cannot deadlock, and
--    the events deleted in the same transaction: each failure counts once.
--    A thread idle past its 30-day window starts over. Failures of a workspace
--    being purged are consumed without recreating a thread purge removed.
CREATE FUNCTION app.fold_workspace_inbox_events(p_limit integer)
RETURNS TABLE(workspace_id uuid,revision bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'inbox fold limit must be between 1 and 1000' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH picked AS MATERIALIZED (
    SELECT event.id,event.workspace_id,event.workflow_id,event.run_id,
           event.kind,event.occurred_at
      FROM app.workspace_inbox_events event
     ORDER BY event.created_at,event.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  ), grouped AS (
    SELECT picked.workspace_id,picked.workflow_id,count(*) AS occurrences,
           min(picked.occurred_at) AS first_at,max(picked.occurred_at) AS latest_at,
           (array_agg(picked.run_id ORDER BY picked.occurred_at DESC,picked.id DESC))[1] AS latest_run,
           (array_agg(picked.kind ORDER BY picked.occurred_at DESC,picked.id DESC))[1] AS latest_kind
      FROM picked JOIN app.workspaces workspace ON workspace.id=picked.workspace_id
     WHERE workspace.status IN ('active','suspended','pending_deletion')
     GROUP BY picked.workspace_id,picked.workflow_id
  ), folded AS (
    INSERT INTO app.workspace_inbox_threads AS thread (
      workspace_id,workflow_id,revision,occurrence_count,first_occurred_at,
      latest_occurred_at,latest_run_id,latest_kind)
    SELECT grouped.workspace_id,grouped.workflow_id,
           nextval('app.workspace_inbox_revision_seq'),grouped.occurrences,
           grouped.first_at,grouped.latest_at,grouped.latest_run,grouped.latest_kind
      FROM grouped ORDER BY grouped.workspace_id,grouped.workflow_id
    ON CONFLICT ON CONSTRAINT workspace_inbox_threads_pkey DO UPDATE SET
      revision=excluded.revision,
      occurrence_count=CASE
        WHEN thread.latest_occurred_at<=statement_timestamp()-interval '720 hours'
        THEN excluded.occurrence_count
        ELSE thread.occurrence_count+excluded.occurrence_count END,
      first_occurred_at=CASE
        WHEN thread.latest_occurred_at<=statement_timestamp()-interval '720 hours'
        THEN excluded.first_occurred_at
        ELSE least(thread.first_occurred_at,excluded.first_occurred_at) END,
      latest_occurred_at=greatest(thread.latest_occurred_at,excluded.latest_occurred_at),
      latest_run_id=CASE WHEN excluded.latest_occurred_at>=thread.latest_occurred_at
        THEN excluded.latest_run_id ELSE thread.latest_run_id END,
      latest_kind=CASE WHEN excluded.latest_occurred_at>=thread.latest_occurred_at
        THEN excluded.latest_kind ELSE thread.latest_kind END,
      updated_at=clock_timestamp()
    RETURNING thread.workspace_id,thread.revision
  ), consumed AS (
    DELETE FROM app.workspace_inbox_events event USING picked
     WHERE event.id=picked.id
  )
  SELECT folded.workspace_id,max(folded.revision)::bigint
    FROM folded GROUP BY folded.workspace_id;
END $$;

-- 7. Remove threads idle past their 30-day window, with their reads, in
--    bounded batches. Workspaces under a legal hold keep theirs; the window
--    still hides them from readers.
CREATE FUNCTION app.expire_workspace_inbox_threads(p_limit integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE v_removed integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'inbox expiry limit must be between 1 and 1000' USING ERRCODE='22023';
  END IF;
  WITH expired AS MATERIALIZED (
    SELECT thread.workspace_id,thread.workflow_id
      FROM app.workspace_inbox_threads thread
     WHERE thread.latest_occurred_at<=statement_timestamp()-interval '720 hours'
       AND NOT EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
         WHERE hold.workspace_id=thread.workspace_id AND hold.released_sequence IS NULL)
     ORDER BY thread.latest_occurred_at,thread.workspace_id,thread.workflow_id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.workspace_inbox_threads thread USING expired
   WHERE thread.workspace_id=expired.workspace_id
     AND thread.workflow_id=expired.workflow_id;
  GET DIAGNOSTICS v_removed=ROW_COUNT;
  RETURN v_removed;
END $$;

ALTER FUNCTION app.fold_workspace_inbox_events(integer) OWNER TO {{owner_role}};
ALTER FUNCTION app.expire_workspace_inbox_threads(integer) OWNER TO {{owner_role}};
REVOKE ALL ON FUNCTION app.fold_workspace_inbox_events(integer),
  app.expire_workspace_inbox_threads(integer)
  FROM PUBLIC,{{api_runtime_role}},{{dispatcher_role}},{{maintenance_role}},
    {{operator_role}},{{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.fold_workspace_inbox_events(integer),
  app.expire_workspace_inbox_threads(integer)
  TO {{worker_runtime_role}};

-- 8. Workspace purge removes the new tables child-first instead of the retired
--    ones. The marker must occur exactly once.
DO $$
DECLARE v_definition text; v_marker text; v_matches integer;
BEGIN
  SELECT pg_get_functiondef('app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)'::regprocedure)
    INTO v_definition;
  v_marker:='''workspace_inbox_entries'', ''workspace_inbox_audience'', ''workspace_inbox_recipient_state'', ''workspace_inbox_sources'', ''workflow_runs''';
  v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);
  IF v_matches<>1 THEN
    RAISE EXCEPTION 'workspace tenant purge function shape is incompatible (% matches)',v_matches;
  END IF;
  EXECUTE replace(v_definition,v_marker,
    '''workspace_inbox_reads'', ''workspace_inbox_threads'', ''workspace_inbox_events'', ''workflow_runs''');
END $$;
