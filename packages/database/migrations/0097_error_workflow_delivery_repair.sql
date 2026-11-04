CREATE INDEX "outbox_events_error_workflow_repair_idx" ON "app"."outbox_events" USING btree ("delivery_due_at","id") WHERE (job_name='start-error-workflow' AND failed_at IS NOT NULL AND delivery_due_at IS NOT NULL);--> statement-breakpoint
GRANT UPDATE(outbox_event_id) ON app.run_error_workflow_intents TO {{maintenance_role}};
--> statement-breakpoint
-- Keep pre-upgrade pending intents discoverable after their delivery gave up.
DO $$
DECLARE workspace uuid; prior_workspace text;
BEGIN
  prior_workspace:=current_setting('app.workspace_id',true);
  FOR workspace IN SELECT id FROM app.workspaces ORDER BY id LOOP
    PERFORM set_config('app.workspace_id',workspace::text,true);
    UPDATE app.outbox_events event SET delivery_due_at=clock_timestamp(),updated_at=clock_timestamp()
      FROM app.run_error_workflow_intents intent
      WHERE intent.workspace_id=workspace AND intent.status='pending'
        AND event.workspace_id=intent.workspace_id AND event.id=intent.outbox_event_id
        AND event.aggregate_id=intent.source_run_id AND event.aggregate_type='workflow-run'
        AND event.job_name='start-error-workflow' AND event.failed_at IS NOT NULL AND event.delivery_due_at IS NULL;
  END LOOP;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
END $$;
