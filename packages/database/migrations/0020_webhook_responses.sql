CREATE TABLE "app"."webhook_run_responses" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"wait_seconds" integer NOT NULL,
	"status_code" integer,
	"content_type" varchar(64),
	"headers" jsonb,
	"body" text,
	"node_run_id" uuid,
	"invocation_key" varchar(256),
	"responded_at" timestamp with time zone,
	CONSTRAINT "webhook_run_responses_wait_valid" CHECK (wait_seconds BETWEEN 1 AND 30),
	CONSTRAINT "webhook_run_responses_body_bound" CHECK (octet_length(body) <= 1048576),
	CONSTRAINT "webhook_run_responses_complete" CHECK (((responded_at IS NULL AND status_code IS NULL AND content_type IS NULL AND headers IS NULL AND body IS NULL AND node_run_id IS NULL AND invocation_key IS NULL) OR (responded_at IS NOT NULL AND status_code BETWEEN 200 AND 599 AND content_type IN ('application/json','text/plain') AND headers IS NOT NULL AND jsonb_typeof(headers)='object' AND body IS NOT NULL AND node_run_id IS NOT NULL AND invocation_key IS NOT NULL)) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "app"."workflow_triggers" DROP CONSTRAINT "workflow_triggers_config_strict";--> statement-breakpoint
ALTER TABLE "app"."preview_runs" DROP CONSTRAINT "preview_runs_definition_key_format";--> statement-breakpoint
ALTER TABLE "app"."preview_runs" DROP CONSTRAINT "preview_runs_executor_key_format";--> statement-breakpoint
ALTER TABLE "app"."webhook_run_responses" ADD CONSTRAINT "webhook_run_responses_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "app"."workflow_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_triggers" ADD CONSTRAINT "workflow_triggers_config_strict" CHECK (jsonb_typeof(desired_config) = 'object');--> statement-breakpoint
ALTER TABLE "app"."preview_runs" ADD CONSTRAINT "preview_runs_definition_key_format" CHECK (definition_key ~ $node_key$^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$$node_key$);--> statement-breakpoint
ALTER TABLE "app"."preview_runs" ADD CONSTRAINT "preview_runs_executor_key_format" CHECK (executor_key ~ $node_key$^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$$node_key$);
--> statement-breakpoint
ALTER TABLE app.webhook_run_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_run_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_run_responses_workspace_scope ON app.webhook_run_responses TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY webhook_run_responses_owner ON app.webhook_run_responses TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY webhook_run_responses_maintenance ON app.webhook_run_responses TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.webhook_run_responses TO {{app_role}};
GRANT SELECT,DELETE ON app.webhook_run_responses TO {{maintenance_role}};
