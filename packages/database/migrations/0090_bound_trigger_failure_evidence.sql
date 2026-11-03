-- The rule supports at most 100 failures. Keep the newest eligible positions:
-- any later success that removes one also supersedes every discarded position.
-- Existing pause evidence and opaque legacy carry remain authoritative.
DO $$
DECLARE
  workspace uuid;
  prior_workspace text;
BEGIN
  prior_workspace := current_setting('app.workspace_id',true);
  FOR workspace IN SELECT id FROM app.workspaces ORDER BY id LOOP
    PERFORM set_config('app.workspace_id',workspace::text,true);
    DELETE FROM app.workflow_trigger_failures f
      USING app.workflow_failure_streaks s
      WHERE f.workspace_id=workspace AND s.workspace_id=f.workspace_id
        AND s.workflow_id=f.workflow_id
        AND (f.ended_at<=s.resumed_after
          OR (f.ended_at,f.id)<=(s.success_ended_at,s.success_outcome_id));
    WITH ranked AS (
      SELECT id,row_number() OVER (PARTITION BY workflow_id ORDER BY ended_at DESC,id DESC) position
      FROM app.workflow_trigger_failures WHERE workspace_id=workspace
    )
    DELETE FROM app.workflow_trigger_failures f USING ranked r
      WHERE f.id=r.id AND r.position>100;
    UPDATE app.workflow_failure_streaks s
      SET consecutive_failures=greatest(s.legacy_failures,least(100,s.legacy_failures+
        (SELECT count(*)::integer FROM app.workflow_trigger_failures f
         WHERE f.workspace_id=s.workspace_id AND f.workflow_id=s.workflow_id)))
      FROM app.workflows w
      WHERE s.workspace_id=workspace AND w.workspace_id=s.workspace_id
        AND w.id=s.workflow_id;
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
END $$;
