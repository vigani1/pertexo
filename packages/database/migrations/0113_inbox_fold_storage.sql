-- Core owns aggregation, latest failure, notice windows and revision allocation.
DROP FUNCTION app.fold_workspace_inbox_events(integer,interval);
--> statement-breakpoint
-- This capability only claims a bounded queue page and returns stored facts.
CREATE FUNCTION app.claim_workspace_inbox_events(p_limit integer)
RETURNS TABLE(id uuid,workspace_id uuid,workflow_id uuid,run_id uuid,kind varchar,occurred_at text,workspace_status varchar)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','app','pg_temp'
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
REVOKE ALL ON FUNCTION app.claim_workspace_inbox_events(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_workspace_inbox_events(integer) TO {{app_role}};
COMMENT ON FUNCTION app.claim_workspace_inbox_events(integer) IS
  'Queue claiming only; the caller retains row locks until scoped thread writes and consumption commit.';
--> statement-breakpoint
-- As with thread writes, consumption requires a worker and its workspace fence.
CREATE POLICY workspace_inbox_events_worker_select ON app.workspace_inbox_events
  FOR SELECT TO {{app_role}} USING (
    workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'')
    AND NULLIF(current_setting('app.actor_id',true),'') IS NULL);
CREATE POLICY workspace_inbox_events_worker_delete ON app.workspace_inbox_events
  FOR DELETE TO {{app_role}} USING (
    workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'')
    AND NULLIF(current_setting('app.actor_id',true),'') IS NULL);
GRANT SELECT,DELETE ON app.workspace_inbox_events TO {{app_role}};
