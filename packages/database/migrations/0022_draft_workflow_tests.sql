CREATE TABLE "app"."workflow_test_snapshots" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"draft_revision" integer NOT NULL,
	"graph_json" jsonb NOT NULL,
	"checksum" varchar(74) NOT NULL,
	"executable_json" jsonb NOT NULL,
	"dispositions" jsonb NOT NULL,
	"pins" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workflow_test_snapshots_checksum_valid" CHECK (checksum ~ '^wf:sha256:[0-9a-f]{64}$'),
	CONSTRAINT "workflow_test_snapshots_revision_positive" CHECK (draft_revision > 0),
	CONSTRAINT "workflow_test_snapshots_graph_bound" CHECK (jsonb_typeof(graph_json)='object' AND octet_length(graph_json::text)<=2097152),
	CONSTRAINT "workflow_test_snapshots_executable_bound" CHECK (jsonb_typeof(executable_json)='object' AND octet_length(executable_json::text)<=2097152),
	CONSTRAINT "workflow_test_snapshots_pins_bound" CHECK (jsonb_typeof(pins)='object' AND octet_length(pins::text)<=67108864)
);
--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" DROP CONSTRAINT "workflow_runs_trigger_type_valid";--> statement-breakpoint
ALTER TABLE "app"."workflow_test_snapshots" ADD CONSTRAINT "workflow_test_snapshots_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "app"."workflow_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_one_active_test" ON "app"."workflow_runs" USING btree ("workspace_id","workflow_id","started_by") WHERE trigger_type='test' AND status IN ('queued','running','waiting');--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD CONSTRAINT "workflow_runs_trigger_type_valid" CHECK (((trigger_type)::text = ANY (ARRAY[('test'::character varying)::text,('form'::character varying)::text, ('workflow_error'::character varying)::text, ('api'::character varying)::text, ('manual'::character varying)::text, ('replay'::character varying)::text, ('schedule'::character varying)::text, ('webhook'::character varying)::text, ('workflow_call'::character varying)::text])));
--> statement-breakpoint
ALTER TABLE app.workflow_test_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_test_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_test_snapshots_workspace_scope ON app.workflow_test_snapshots TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workflow_test_snapshots_owner ON app.workflow_test_snapshots TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workflow_test_snapshots_maintenance ON app.workflow_test_snapshots TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT ON app.workflow_test_snapshots TO {{app_role}};
GRANT SELECT,DELETE ON app.workflow_test_snapshots TO {{maintenance_role}};
