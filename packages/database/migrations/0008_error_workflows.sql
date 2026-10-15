CREATE TABLE "app"."workflow_error_policies" (
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"target_workflow_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "workflow_error_policies_workspace_id_workflow_id_pk" PRIMARY KEY("workspace_id","workflow_id"),
	CONSTRAINT "workflow_error_policies_revision_positive" CHECK (revision > 0),
	CONSTRAINT "workflow_error_policies_different_target" CHECK (workflow_id <> target_workflow_id)
);
--> statement-breakpoint
CREATE TABLE "app"."run_error_workflow_intents" (
	"workspace_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"target_workflow_id" uuid NOT NULL,
	"target_version_id" uuid NOT NULL,
	"context" jsonb NOT NULL,
	"outbox_event_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"accepted_run_id" uuid,
	"refusal_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "run_error_workflow_intents_workspace_id_source_run_id_pk" PRIMARY KEY("workspace_id","source_run_id"),
	CONSTRAINT "run_error_workflow_intents_context_bounded" CHECK (jsonb_typeof(context) = 'object' AND octet_length(context::text) <= 8192),
	CONSTRAINT "run_error_workflow_intents_state_valid" CHECK (((status = 'pending' AND accepted_run_id IS NULL AND refusal_code IS NULL AND completed_at IS NULL) OR (status = 'accepted' AND accepted_run_id IS NOT NULL AND refusal_code IS NULL AND completed_at IS NOT NULL) OR (status = 'refused' AND accepted_run_id IS NULL AND refusal_code IN ('target_unavailable','workspace_unavailable','queue_full','invalid_target') AND completed_at IS NOT NULL)) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" DROP CONSTRAINT "workflow_runs_trigger_type_valid";--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD COLUMN "error_workflow_origin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workflow_error_policies" ADD CONSTRAINT "workflow_error_policies_workspace_id_workflow_id_workflows_workspace_id_id_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "app"."workflows"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_error_policies" ADD CONSTRAINT "workflow_error_policies_workspace_id_target_workflow_id_workflows_workspace_id_id_fk" FOREIGN KEY ("workspace_id","target_workflow_id") REFERENCES "app"."workflows"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."run_error_workflow_intents" ADD CONSTRAINT "run_error_workflow_intents_source_fk" FOREIGN KEY ("workspace_id","source_run_id") REFERENCES "app"."workflow_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."run_error_workflow_intents" ADD CONSTRAINT "run_error_workflow_intents_version_fk" FOREIGN KEY ("workspace_id","target_workflow_id","target_version_id") REFERENCES "app"."workflow_versions"("workspace_id","workflow_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_error_policies_target_idx" ON "app"."workflow_error_policies" USING btree ("workspace_id","target_workflow_id");--> statement-breakpoint
CREATE INDEX "run_error_workflow_intents_target_idx" ON "app"."run_error_workflow_intents" USING btree ("workspace_id","target_version_id");--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD CONSTRAINT "workflow_runs_trigger_type_valid" CHECK (((trigger_type)::text = ANY (ARRAY[('workflow_error'::character varying)::text, ('api'::character varying)::text, ('manual'::character varying)::text, ('replay'::character varying)::text, ('schedule'::character varying)::text, ('webhook'::character varying)::text, ('workflow_call'::character varying)::text])));
--> statement-breakpoint
ALTER TABLE app.workflow_error_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_error_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_error_policies_workspace_scope ON app.workflow_error_policies TO {{app_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));
CREATE POLICY workflow_error_policies_owner ON app.workflow_error_policies TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workflow_error_policies_maintenance ON app.workflow_error_policies TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON app.workflow_error_policies TO {{app_role}};
GRANT SELECT, DELETE ON app.workflow_error_policies TO {{maintenance_role}};
ALTER TABLE app.run_error_workflow_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.run_error_workflow_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY run_error_workflow_intents_workspace_scope ON app.run_error_workflow_intents TO {{app_role}}
  USING (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = NULLIF(current_setting('app.workspace_id', true), ''));
CREATE POLICY run_error_workflow_intents_owner ON app.run_error_workflow_intents TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY run_error_workflow_intents_maintenance ON app.run_error_workflow_intents TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON app.run_error_workflow_intents TO {{app_role}};
GRANT SELECT, DELETE ON app.run_error_workflow_intents TO {{maintenance_role}};
GRANT UPDATE (target_workflow_id, revision) ON app.workflow_error_policies TO {{app_role}};
GRANT UPDATE (status, accepted_run_id, refusal_code, completed_at) ON app.run_error_workflow_intents TO {{app_role}};
