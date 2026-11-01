-- The window comes from core's one constant, so this function can't disagree with it.
DROP FUNCTION app.fold_workspace_inbox_events(integer);
--> statement-breakpoint
CREATE FUNCTION app.fold_workspace_inbox_events(p_limit integer,p_notice_window interval) RETURNS TABLE(workspace_id uuid, revision bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'inbox fold limit must be between 1 and 1000' USING ERRCODE='22023';
  END IF;
  IF p_notice_window IS NULL OR p_notice_window<=interval '0' THEN
    RAISE EXCEPTION 'inbox notice window must be positive' USING ERRCODE='22023';
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
      workspace_id,id,notice_kind,subject_id,workflow_id,revision,occurrence_count,first_occurred_at,
      latest_occurred_at,latest_run_id,latest_kind)
    SELECT grouped.workspace_id,uuidv7(),'workflow_failure',grouped.workflow_id,grouped.workflow_id,
           nextval('app.workspace_inbox_revision_seq'),grouped.occurrences,
           grouped.first_at,grouped.latest_at,grouped.latest_run,grouped.latest_kind
      FROM grouped ORDER BY grouped.workspace_id,grouped.workflow_id
    ON CONFLICT (workspace_id,notice_kind,subject_id) DO UPDATE SET
      revision=excluded.revision,
      occurrence_count=CASE
        WHEN thread.latest_occurred_at<=statement_timestamp()-p_notice_window
        THEN excluded.occurrence_count
        ELSE thread.occurrence_count+excluded.occurrence_count END,
      first_occurred_at=CASE
        WHEN thread.latest_occurred_at<=statement_timestamp()-p_notice_window
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.fold_workspace_inbox_events(integer,interval) FROM PUBLIC;
--> statement-breakpoint
GRANT ALL ON FUNCTION app.fold_workspace_inbox_events(integer,interval) TO {{app_role}};
