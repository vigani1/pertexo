CREATE TABLE "app"."workspace_variables" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"values_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "workspace_variables_revision_positive" CHECK (revision>0),
	CONSTRAINT "workspace_variables_values_bounded" CHECK (jsonb_typeof(values_json)='object' AND octet_length(values_json::text)<=65536)
);
--> statement-breakpoint
ALTER TABLE "app"."preview_runs" ADD COLUMN "variable_snapshot" jsonb DEFAULT '{"revision":0,"values":{}}'::jsonb;--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD COLUMN "variable_snapshot" jsonb DEFAULT '{"revision":0,"values":{}}'::jsonb;--> statement-breakpoint
UPDATE app.workflow_runs SET variable_snapshot=NULL WHERE details_purged_at IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."workspace_variables" ADD CONSTRAINT "workspace_variables_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."preview_runs" ADD CONSTRAINT "preview_runs_variable_snapshot_valid" CHECK ((variable_snapshot IS NOT NULL AND jsonb_typeof(variable_snapshot)='object' AND octet_length(variable_snapshot::text)<=65536) IS TRUE);--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD CONSTRAINT "workflow_runs_variable_snapshot_valid" CHECK (((variable_snapshot IS NOT NULL AND jsonb_typeof(variable_snapshot)='object' AND octet_length(variable_snapshot::text)<=65536) OR (variable_snapshot IS NULL AND details_purged_at IS NOT NULL)) IS TRUE);
--> statement-breakpoint
ALTER TABLE app.workspace_variables ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_variables FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_variables_workspace_scope ON app.workspace_variables TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workspace_variables_owner ON app.workspace_variables TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workspace_variables_maintenance ON app.workspace_variables TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT ON app.workspace_variables TO {{app_role}};
GRANT UPDATE(revision,values_json,updated_at) ON app.workspace_variables TO {{app_role}};
GRANT SELECT,DELETE ON app.workspace_variables TO {{maintenance_role}};
GRANT UPDATE(variable_snapshot) ON app.workflow_runs TO {{maintenance_role}};
