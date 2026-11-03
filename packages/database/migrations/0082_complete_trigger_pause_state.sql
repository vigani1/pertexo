-- Older CHECKs admitted UNKNOWN when either nullable pause detail was missing.
-- Preserve the pause. Prefer its retained audit count; when that history expired,
-- retain the best available positive streak or configured threshold as a lower-bound repair.
DO $$
DECLARE workspace uuid; prior_workspace text:=current_setting('app.workspace_id',true);
BEGIN
  FOR workspace IN SELECT id FROM app.workspaces LOOP
    PERFORM set_config('app.workspace_id',workspace::text,true);
    UPDATE app.workflows workflow SET
  trigger_pause_reason='consecutive_failures',
  trigger_pause_failures=coalesce(workflow.trigger_pause_failures,
    (SELECT (event.metadata->>'failures')::integer FROM app.audit_events event
      WHERE event.workspace_id=workflow.workspace_id AND event.target_id=workflow.id
        AND event.action='workflow.triggers_paused'
        AND event.metadata->>'failures' ~ '^[1-9][0-9]{0,8}$'
      ORDER BY event.occurred_at DESC,event.id DESC LIMIT 1),
    (SELECT nullif(streak.consecutive_failures,0) FROM app.workflow_failure_streaks streak
      WHERE streak.workspace_id=workflow.workspace_id AND streak.workflow_id=workflow.id),
    workflow.auto_pause_threshold,
    (SELECT workspace.auto_pause_threshold FROM app.workspaces workspace WHERE workspace.id=workflow.workspace_id))
WHERE workflow.trigger_pause_state='paused'
  AND (workflow.trigger_pause_reason IS NULL OR workflow.trigger_pause_failures IS NULL);
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
END $$;
--> statement-breakpoint
ALTER TABLE "app"."workflows" DROP CONSTRAINT "workflows_trigger_pause_valid";--> statement-breakpoint
ALTER TABLE "app"."workflows" ADD CONSTRAINT "workflows_trigger_pause_valid" CHECK (((trigger_pause_revision > 0) AND ((((trigger_pause_state)::text = 'none'::text) AND (trigger_paused_at IS NULL) AND (trigger_pause_reason IS NULL) AND (trigger_pause_failures IS NULL) AND (trigger_pause_last_run_id IS NULL)) OR (((trigger_pause_state)::text = 'paused'::text) AND (trigger_paused_at IS NOT NULL) AND (trigger_pause_reason IS NOT NULL) AND ((trigger_pause_reason)::text = 'consecutive_failures'::text) AND (trigger_pause_failures IS NOT NULL) AND (trigger_pause_failures > 0) AND (trigger_pause_last_run_id IS NOT NULL)))) IS TRUE);