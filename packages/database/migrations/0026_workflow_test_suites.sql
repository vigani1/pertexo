CREATE TABLE "app"."workflow_test_suite_cases" (
	"workspace_id" uuid NOT NULL,
	"suite_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"case_id" uuid NOT NULL,
	"case_revision" integer NOT NULL,
	"name" varchar(128) NOT NULL,
	"input" text NOT NULL,
	"expectations" text NOT NULL,
	"run_id" uuid,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"report" text,
	CONSTRAINT "workflow_test_suite_cases_pkey" PRIMARY KEY("workspace_id","suite_id","ordinal"),
	CONSTRAINT "workflow_test_suite_cases_ordinal_valid" CHECK (ordinal between 0 and 49 AND case_revision>0),
	CONSTRAINT "workflow_test_suite_cases_status_valid" CHECK (status in ('pending','running','passed','failed','error','skipped')),
	CONSTRAINT "workflow_test_suite_cases_payload_bound" CHECK (octet_length(input)<=65536 AND input::jsonb is not null AND octet_length(expectations)<=16384 AND jsonb_typeof(expectations::jsonb)='object'),
	CONSTRAINT "workflow_test_suite_cases_report_bound" CHECK (report is null OR (octet_length(report)<=262144 AND jsonb_typeof(report::jsonb)='object'))
);
--> statement-breakpoint
CREATE TABLE "app"."workflow_test_suites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"started_by" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"signature" varchar(64) NOT NULL,
	"variable_set_revision" integer,
	"uses_connections" boolean NOT NULL,
	"case_duration_ms" integer NOT NULL,
	"initial_checkpoint" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'running' NOT NULL,
	"stop_reason" varchar(64),
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "workflow_test_suites_workspace_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "workflow_test_suites_status_valid" CHECK (status in ('running','passed','failed','canceled','error')),
	CONSTRAINT "workflow_test_suites_duration_valid" CHECK (case_duration_ms between 1 and 300000 AND deadline_at>created_at AND expires_at>deadline_at),
	CONSTRAINT "workflow_test_suites_signature_valid" CHECK (signature ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workflow_test_suites_checkpoint_bound" CHECK (jsonb_typeof(initial_checkpoint)='object' AND octet_length(initial_checkpoint::text)<=262144)
);
--> statement-breakpoint
ALTER TABLE "app"."workflow_test_snapshots" RENAME COLUMN "run_id" TO "id";--> statement-breakpoint
ALTER TABLE "app"."workflow_input_case_payloads" DROP CONSTRAINT "workflow_input_case_payloads_canonical_bytes_check";--> statement-breakpoint
ALTER TABLE "app"."workflow_input_case_payloads" DROP CONSTRAINT "workflow_input_case_payloads_check";--> statement-breakpoint
ALTER TABLE "app"."workflow_test_snapshots" DROP CONSTRAINT "workflow_test_snapshots_run_fk";
--> statement-breakpoint
ALTER TABLE "app"."workflow_input_case_payloads" ADD COLUMN "expectations" text;--> statement-breakpoint
ALTER TABLE "app"."workflow_test_snapshots" ADD COLUMN "workflow_id" uuid;
--> statement-breakpoint
UPDATE app.workflow_test_snapshots snapshot SET workflow_id=run.workflow_id FROM app.workflow_runs run WHERE run.workspace_id=snapshot.workspace_id AND run.id=snapshot.id;
--> statement-breakpoint
ALTER TABLE app.workflow_test_snapshots ALTER COLUMN workflow_id SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workflow_test_suite_cases" ADD CONSTRAINT "workflow_test_suite_cases_suite_fk" FOREIGN KEY ("workspace_id","suite_id") REFERENCES "app"."workflow_test_suites"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_test_snapshots" ADD CONSTRAINT "workflow_test_snapshots_workspace_id_key" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "app"."workflow_test_suites" ADD CONSTRAINT "workflow_test_suites_source_fk" FOREIGN KEY ("workspace_id","snapshot_id") REFERENCES "app"."workflow_test_snapshots"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_test_suites" ADD CONSTRAINT "workflow_test_suites_variables_fk" FOREIGN KEY ("workspace_id","variable_set_revision") REFERENCES "app"."workspace_variable_set_revisions"("workspace_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_test_suite_cases_one_running" ON "app"."workflow_test_suite_cases" USING btree ("workspace_id","suite_id") WHERE status='running';--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_test_suite_cases_run_key" ON "app"."workflow_test_suite_cases" USING btree ("workspace_id","run_id") WHERE run_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_test_suites_active_starter_key" ON "app"."workflow_test_suites" USING btree ("workspace_id","workflow_id","started_by") WHERE status='running';--> statement-breakpoint
CREATE INDEX "workflow_test_suites_due_idx" ON "app"."workflow_test_suites" USING btree ("next_check_at","id") WHERE status='running';--> statement-breakpoint
CREATE INDEX "workflow_test_suites_history_idx" ON "app"."workflow_test_suites" USING btree ("workspace_id","workflow_id","created_at","id");--> statement-breakpoint
CREATE INDEX "workflow_test_suites_expiry_idx" ON "app"."workflow_test_suites" USING btree ("expires_at","id");--> statement-breakpoint
-- FK validation must see every retained source's workflow. The migration owns
-- the table lock and restores the normal forced workspace fence immediately.
ALTER TABLE app.workflows NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."workflow_test_snapshots" ADD CONSTRAINT "workflow_test_snapshots_workflow_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "app"."workflows"("workspace_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE app.workflows FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "node_runs_run_node_idx" ON "app"."node_runs" USING btree ("workspace_id","workflow_run_id","node_id","id");--> statement-breakpoint
CREATE INDEX "workflow_runs_test_source_idx" ON "app"."workflow_runs" USING btree ("workspace_id","workflow_version_id") WHERE trigger_type='test';--> statement-breakpoint
ALTER TABLE "app"."workflow_input_case_payloads" ADD CONSTRAINT "workflow_input_case_payloads_expectations_bound" CHECK (octet_length(input)<=65536 AND (expectations IS NULL OR (octet_length(expectations)<=16384 AND jsonb_typeof(expectations::jsonb)='object')));--> statement-breakpoint
ALTER TABLE "app"."workflow_input_case_payloads" ADD CONSTRAINT "workflow_input_case_payloads_canonical_bytes_check" CHECK (((canonical_bytes >= 1) AND (canonical_bytes <= 81920)));--> statement-breakpoint
ALTER TABLE "app"."workflow_input_case_payloads" ADD CONSTRAINT "workflow_input_case_payloads_check" CHECK ((octet_length(input)+coalesce(octet_length(expectations),0) = canonical_bytes));
--> statement-breakpoint
GRANT UPDATE(expires_at) ON app.workflow_test_snapshots TO {{app_role}};

--> statement-breakpoint
ALTER TABLE app.workflow_test_suites ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_test_suites FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_test_suites_workspace_scope ON app.workflow_test_suites TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workflow_test_suites_owner ON app.workflow_test_suites TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workflow_test_suites_maintenance ON app.workflow_test_suites TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE ON app.workflow_test_suites TO {{app_role}};
GRANT SELECT,DELETE ON app.workflow_test_suites TO {{maintenance_role}};

--> statement-breakpoint
ALTER TABLE app.workflow_test_suite_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_test_suite_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_test_suite_cases_workspace_scope ON app.workflow_test_suite_cases TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workflow_test_suite_cases_owner ON app.workflow_test_suite_cases TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workflow_test_suite_cases_maintenance ON app.workflow_test_suite_cases TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE ON app.workflow_test_suite_cases TO {{app_role}};
GRANT SELECT,DELETE ON app.workflow_test_suite_cases TO {{maintenance_role}};
