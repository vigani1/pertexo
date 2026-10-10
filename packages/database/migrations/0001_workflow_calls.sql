CREATE TABLE "app"."workflow_version_dependencies" (
	"workspace_id" uuid NOT NULL,
	"parent_version_id" uuid NOT NULL,
	"node_id" varchar(64) NOT NULL,
	"target_workflow_id" uuid NOT NULL,
	"target_version_id" uuid NOT NULL,
	CONSTRAINT "workflow_version_dependencies_workspace_id_parent_version_id_node_id_pk" PRIMARY KEY("workspace_id","parent_version_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "app"."workflow_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"parent_run_id" uuid NOT NULL,
	"invocation_key" varchar(256) NOT NULL,
	"target_workflow_id" uuid NOT NULL,
	"target_version_id" uuid NOT NULL,
	"target_checksum" varchar(74) NOT NULL,
	"input_ref" jsonb,
	"input_checksum" char(64) NOT NULL,
	"deadline_at" timestamp with time zone,
	"status" varchar(32) NOT NULL,
	"child_run_id" uuid,
	"live_child_run_id" uuid,
	"result_ref" jsonb,
	"safe_error_code" varchar(128),
	"slot_lent" boolean DEFAULT false NOT NULL,
	"consumed_at" timestamp with time zone,
	"details_purged_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"cancel_applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "workflow_calls_workspace_identity_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "workflow_calls_invocation_unique" UNIQUE("workspace_id","parent_run_id","invocation_key"),
	CONSTRAINT "workflow_calls_child_unique" UNIQUE("workspace_id","child_run_id"),
	CONSTRAINT "workflow_calls_status_valid" CHECK (status in ('pending','accepted','refused','succeeded','failed','canceled','timed_out','outcome_unknown')),
	CONSTRAINT "workflow_calls_live_child_identity_valid" CHECK (live_child_run_id is null or (child_run_id is not null and live_child_run_id = child_run_id)),
	CONSTRAINT "workflow_calls_values_bounded" CHECK ((input_ref is null or octet_length(input_ref::text) <= 4194304) and (result_ref is null or octet_length(result_ref::text) <= 4194304)),
	CONSTRAINT "workflow_calls_retired_details_valid" CHECK (details_purged_at is null or (input_ref is null and result_ref is null))
);
--> statement-breakpoint
ALTER TABLE "app"."workflow_run_active_admissions" ADD COLUMN "borrowed_call_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."workflow_version_dependencies" ADD CONSTRAINT "workflow_version_dependencies_parent_fk" FOREIGN KEY ("workspace_id","parent_version_id") REFERENCES "app"."workflow_versions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_version_dependencies" ADD CONSTRAINT "workflow_version_dependencies_target_fk" FOREIGN KEY ("workspace_id","target_workflow_id","target_version_id") REFERENCES "app"."workflow_versions"("workspace_id","workflow_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_calls" ADD CONSTRAINT "workflow_calls_parent_fk" FOREIGN KEY ("workspace_id","parent_run_id") REFERENCES "app"."workflow_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_calls" ADD CONSTRAINT "workflow_calls_live_child_fk" FOREIGN KEY ("workspace_id","live_child_run_id") REFERENCES "app"."workflow_runs"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_calls" ADD CONSTRAINT "workflow_calls_target_version_fk" FOREIGN KEY ("workspace_id","target_workflow_id","target_version_id") REFERENCES "app"."workflow_versions"("workspace_id","workflow_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_version_dependencies_target_idx" ON "app"."workflow_version_dependencies" USING btree ("workspace_id","target_workflow_id","parent_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_calls_one_loan_per_parent_idx" ON "app"."workflow_calls" USING btree ("workspace_id","parent_run_id") WHERE slot_lent;--> statement-breakpoint
CREATE INDEX "workflow_calls_live_child_idx" ON "app"."workflow_calls" USING btree ("workspace_id","live_child_run_id") WHERE live_child_run_id is not null;--> statement-breakpoint
ALTER TABLE "app"."workflow_run_active_admissions" ADD CONSTRAINT "workflow_run_active_admissions_call_fk" FOREIGN KEY ("workspace_id","borrowed_call_id") REFERENCES "app"."workflow_calls"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_run_active_admissions" ADD CONSTRAINT "workflow_run_active_admissions_call_unique" UNIQUE("borrowed_call_id");
--> statement-breakpoint
ALTER TABLE app.workflow_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_calls FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_version_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_version_dependencies FORCE ROW LEVEL SECURITY;

CREATE POLICY workflow_calls_workspace_scope ON app.workflow_calls
  TO {{owner_role}}, {{app_role}}
  USING (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''));
CREATE POLICY workflow_calls_capacity_owner_select ON app.workflow_calls
  FOR SELECT TO {{owner_role}} USING (true);
CREATE POLICY workflow_calls_maintenance ON app.workflow_calls
  TO {{maintenance_role}} USING (true) WITH CHECK (true);
CREATE POLICY workflow_version_dependencies_workspace_scope ON app.workflow_version_dependencies
  TO {{owner_role}}, {{app_role}}
  USING (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''));
CREATE POLICY workflow_version_dependencies_maintenance ON app.workflow_version_dependencies
  TO {{maintenance_role}} USING (true) WITH CHECK (true);

REVOKE ALL ON app.workflow_calls, app.workflow_version_dependencies FROM PUBLIC;
GRANT SELECT, INSERT ON app.workflow_calls TO {{app_role}}, {{maintenance_role}};
GRANT UPDATE (status, child_run_id, live_child_run_id, result_ref, safe_error_code,
  slot_lent, consumed_at, cancel_requested_at, cancel_applied_at, completed_at)
  ON app.workflow_calls TO {{app_role}}, {{maintenance_role}};
GRANT UPDATE (input_ref, details_purged_at), DELETE ON app.workflow_calls TO {{maintenance_role}};
GRANT SELECT, INSERT ON app.workflow_version_dependencies TO {{app_role}};
GRANT SELECT, DELETE ON app.workflow_version_dependencies TO {{maintenance_role}};
