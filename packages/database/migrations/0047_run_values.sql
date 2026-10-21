CREATE TABLE "app"."workflow_run_values" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workflow_run_id" uuid,
	"preview_run_id" uuid,
	"key" varchar(50) NOT NULL,
	"value" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_run_values_run_key" UNIQUE("workspace_id","workflow_run_id","key"),
	CONSTRAINT "workflow_run_values_preview_key" UNIQUE("workspace_id","preview_run_id","key"),
	CONSTRAINT "workflow_run_values_one_owner" CHECK ((workflow_run_id IS NULL) <> (preview_run_id IS NULL))
);
--> statement-breakpoint
ALTER TABLE "app"."workflow_run_values" ADD CONSTRAINT "workflow_run_values_run_fk" FOREIGN KEY ("workspace_id","workflow_run_id") REFERENCES "app"."workflow_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_run_values" ADD CONSTRAINT "workflow_run_values_preview_fk" FOREIGN KEY ("workspace_id","preview_run_id") REFERENCES "app"."preview_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_run_values_lookup_idx" ON "app"."workflow_run_values" USING btree ("workspace_id","key","value","workflow_run_id");
--> statement-breakpoint
ALTER TABLE app.workflow_run_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_run_values FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_run_values_workspace_scope ON app.workflow_run_values TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workflow_run_values_owner ON app.workflow_run_values TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workflow_run_values_maintenance ON app.workflow_run_values TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.workflow_run_values TO {{app_role}};
GRANT SELECT,DELETE ON app.workflow_run_values TO {{maintenance_role}};

-- PostgreSQL requires UPDATE on a column for retention's SKIP LOCKED row claim.
GRANT UPDATE(id) ON app.workflow_run_values TO {{maintenance_role}};
