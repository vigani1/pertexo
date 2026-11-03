-- Each policy is covered by another same-role ALL/equal-command policy.
DROP POLICY "artifacts_owner_retention_delete" ON "app"."artifacts";
--> statement-breakpoint
DROP POLICY "artifacts_owner_retention_update" ON "app"."artifacts";
--> statement-breakpoint
DROP POLICY "node_runs_due_wakeup_owner_select" ON "app"."node_runs";
--> statement-breakpoint
DROP POLICY "outbox_events_dispatcher_select" ON "app"."outbox_events";
--> statement-breakpoint
DROP POLICY "outbox_events_dispatcher_update" ON "app"."outbox_events";
--> statement-breakpoint
DROP POLICY "trigger_schedule_occurrences_retention_scope" ON "app"."trigger_schedule_occurrences";
--> statement-breakpoint
DROP POLICY "trigger_schedules_worker_reconciliation" ON "app"."trigger_schedules";
--> statement-breakpoint
DROP POLICY "webhook_trigger_deliveries_retention_scope" ON "app"."webhook_trigger_deliveries";
--> statement-breakpoint
DROP POLICY "webhook_trigger_endpoints_api_scope" ON "app"."webhook_trigger_endpoints";
--> statement-breakpoint
DROP POLICY "webhook_trigger_replay_records_retention_scope" ON "app"."webhook_trigger_replay_records";
--> statement-breakpoint
DROP POLICY "workflow_triggers_worker_reconciliation" ON "app"."workflow_triggers";
--> statement-breakpoint
DROP POLICY "workflows_worker_trigger_reconciliation" ON "app"."workflows";
