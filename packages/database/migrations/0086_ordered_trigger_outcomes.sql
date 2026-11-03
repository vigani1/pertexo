CREATE TABLE "app"."workflow_trigger_failures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"ended_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."workflow_failure_streaks" ADD COLUMN "legacy_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workflow_failure_streaks" ADD COLUMN "success_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."workflow_failure_streaks" ADD COLUMN "success_outcome_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."workflow_trigger_failures" ADD CONSTRAINT "workflow_trigger_failures_workflow_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "app"."workflows"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_trigger_failures_run_unique" ON "app"."workflow_trigger_failures" USING btree ("workspace_id","run_id");--> statement-breakpoint
CREATE INDEX "workflow_trigger_failures_order_idx" ON "app"."workflow_trigger_failures" USING btree ("workspace_id","workflow_id","ended_at","id");--> statement-breakpoint
ALTER TABLE "app"."workflow_failure_streaks" ADD CONSTRAINT "workflow_failure_streaks_legacy_failures_check" CHECK ((legacy_failures >= 0 AND legacy_failures <= consecutive_failures));--> statement-breakpoint
ALTER TABLE "app"."workflow_failure_streaks" ADD CONSTRAINT "workflow_failure_streaks_success_valid" CHECK (((success_ended_at IS NULL) = (success_outcome_id IS NULL)));
--> statement-breakpoint
-- Existing folds discarded their individual positions. Preserve each count as
-- an opaque carry, and leave pauses, last-run projections and resume cutoffs
-- untouched. New failures extend it; the first eligible success clears the
-- carry while retaining positioned failures after that success. Pending outcomes
-- enter the new ordered stream. Do not invent a historical success watermark.
UPDATE app.workflow_failure_streaks SET legacy_failures=consecutive_failures;
--> statement-breakpoint
ALTER TABLE app.workflow_trigger_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_trigger_failures FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_trigger_failures_owner ON app.workflow_trigger_failures TO {{owner_role}} USING(true) WITH CHECK(true);
CREATE POLICY workflow_trigger_failures_maintenance ON app.workflow_trigger_failures TO {{maintenance_role}} USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,DELETE ON app.workflow_trigger_failures TO {{maintenance_role}};
-- Replace the definer's writes with the existing cross-workspace maintenance
-- authority. The ordinary app login remains insert-only on the pending queue.
GRANT UPDATE ON app.workflow_trigger_outcomes TO {{maintenance_role}};
GRANT SELECT,INSERT,UPDATE ON app.workflow_failure_streaks TO {{maintenance_role}};
GRANT UPDATE(trigger_pause_state,trigger_paused_at,trigger_pause_reason,trigger_pause_failures,trigger_pause_last_run_id,trigger_pause_revision) ON app.workflows TO {{maintenance_role}};
GRANT UPDATE(legacy_failures) ON app.workflow_failure_streaks TO {{app_role}};
