CREATE TABLE "app"."workflow_step_samples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"node_id" varchar(64) NOT NULL,
	"binding" text NOT NULL,
	"output_ref" text NOT NULL,
	"retained_bytes" integer NOT NULL,
	"source_kind" varchar(16) NOT NULL,
	"source_run_id" uuid,
	"source_node_run_id" uuid,
	"source_preview_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workflow_step_samples_step_key" UNIQUE("workspace_id","workflow_id","node_id"),
	CONSTRAINT "workflow_step_samples_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "workflow_step_samples_bytes_valid" CHECK (retained_bytes = octet_length(binding) + octet_length(output_ref) AND retained_bytes > 0 AND retained_bytes <= 1310800),
	CONSTRAINT "workflow_step_samples_output_valid" CHECK (octet_length(output_ref) <= 262200 AND jsonb_typeof(output_ref::jsonb) = 'object' AND output_ref::jsonb->>'kind' = 'inline' AND output_ref::jsonb ? 'value'),
	CONSTRAINT "workflow_step_samples_source_valid" CHECK (((source_kind='json' AND source_run_id IS NULL AND source_node_run_id IS NULL AND source_preview_id IS NULL) OR (source_kind='run' AND source_run_id IS NOT NULL AND source_node_run_id IS NOT NULL AND source_preview_id IS NULL) OR (source_kind='preview' AND source_run_id IS NULL AND source_node_run_id IS NULL AND source_preview_id IS NOT NULL)) IS TRUE),
	CONSTRAINT "workflow_step_samples_expiry_valid" CHECK (expires_at > created_at)
);
--> statement-breakpoint
ALTER TABLE "app"."preview_runs" DROP CONSTRAINT "preview_runs_time_order";--> statement-breakpoint
ALTER TABLE "app"."preview_runs" ADD COLUMN "pinned_sample_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."workflow_step_samples" ADD CONSTRAINT "workflow_step_samples_workflow_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "app"."workflows"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_step_samples_expiry_idx" ON "app"."workflow_step_samples" USING btree ("expires_at","id");--> statement-breakpoint
ALTER TABLE "app"."preview_runs" ADD CONSTRAINT "preview_runs_pinned_sample_valid" CHECK (pinned_sample_id IS NULL OR (status='succeeded' AND side_effect_class='safe' AND may_contact_provider=false AND may_cause_external_side_effect=false AND started_at IS NULL AND completed_at IS NOT NULL));--> statement-breakpoint
ALTER TABLE "app"."preview_runs" ADD CONSTRAINT "preview_runs_time_order" CHECK ((((started_at IS NULL) OR (started_at >= created_at)) AND ((completed_at IS NULL) OR (completed_at >= created_at)) AND ((completed_at IS NULL) OR (started_at IS NOT NULL) OR (pinned_sample_id IS NOT NULL))));
--> statement-breakpoint
ALTER TABLE app.workflow_step_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_step_samples FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_step_samples_workspace_scope ON app.workflow_step_samples TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workflow_step_samples_owner ON app.workflow_step_samples TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workflow_step_samples_maintenance ON app.workflow_step_samples TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.workflow_step_samples TO {{app_role}};
-- The bounded reaper needs an UPDATE privilege for SELECT FOR UPDATE.
GRANT SELECT,DELETE,UPDATE(expires_at) ON app.workflow_step_samples TO {{maintenance_role}};
