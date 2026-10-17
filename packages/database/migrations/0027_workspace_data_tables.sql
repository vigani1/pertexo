CREATE TABLE "app"."data_table_write_receipts" (
	"workspace_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"invocation_id" uuid NOT NULL,
	"run_id" uuid,
	"preview_run_id" uuid,
	"request_hash" varchar(64) NOT NULL,
	"result_json" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_table_write_receipts_workspace_id_execution_id_invocation_id_pk" PRIMARY KEY("workspace_id","execution_id","invocation_id"),
	CONSTRAINT "data_table_receipts_bounds" CHECK ((run_id is null)<>(preview_run_id is null) and execution_id=coalesce(run_id,preview_run_id) and request_hash ~ '^[0-9a-f]{64}$' and octet_length(result_json)<=1048576)
);
--> statement-breakpoint
CREATE TABLE "app"."workspace_data_table_quotas" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"table_limit" integer DEFAULT 20 NOT NULL,
	"column_limit" integer DEFAULT 20 NOT NULL,
	"row_limit" integer DEFAULT 10000 NOT NULL,
	"byte_limit" integer DEFAULT 52428800 NOT NULL,
	"table_count" integer DEFAULT 0 NOT NULL,
	"stored_bytes" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "data_table_quotas_bounds" CHECK (table_limit between 1 and 100 and column_limit between 1 and 50 and row_limit between 1 and 100000 and byte_limit between 65536 and 1073741824 and table_count between 0 and table_limit and stored_bytes between 0 and byte_limit)
);
--> statement-breakpoint
CREATE TABLE "app"."workspace_data_table_rows" (
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"values_json" text NOT NULL,
	"key_value" text,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "workspace_data_table_rows_key" UNIQUE("workspace_id","table_id","key_value"),
	CONSTRAINT "workspace_data_table_rows_bounds" CHECK (octet_length(values_json)<=65536 and jsonb_typeof(values_json::jsonb)='object' and (key_value is null or octet_length(key_value)<=1024) and revision>0)
);
--> statement-breakpoint
CREATE TABLE "app"."workspace_data_tables" (
	"workspace_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"columns_json" jsonb NOT NULL,
	"key_column" varchar(64),
	"row_count" integer DEFAULT 0 NOT NULL,
	"stored_bytes" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_data_tables_identity" UNIQUE("workspace_id","id"),
	CONSTRAINT "workspace_data_tables_name" UNIQUE("workspace_id","name"),
	CONSTRAINT "workspace_data_tables_bounds" CHECK (name ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$' and jsonb_typeof(columns_json)='array' and jsonb_array_length(columns_json) between 1 and 50 and octet_length(columns_json::text)<=16384 and row_count between 0 and 100000 and stored_bytes>=0 and revision>0)
);
--> statement-breakpoint
ALTER TABLE "app"."preview_runs" DROP CONSTRAINT "preview_runs_disclosure_consistent";--> statement-breakpoint
ALTER TABLE "app"."data_table_write_receipts" ADD CONSTRAINT "data_table_write_receipts_workspace_id_run_id_workflow_runs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "app"."workflow_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."data_table_write_receipts" ADD CONSTRAINT "data_table_write_receipts_workspace_id_preview_run_id_preview_runs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","preview_run_id") REFERENCES "app"."preview_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_data_table_quotas" ADD CONSTRAINT "workspace_data_table_quotas_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_data_table_rows" ADD CONSTRAINT "workspace_data_table_rows_workspace_id_table_id_workspace_data_tables_workspace_id_id_fk" FOREIGN KEY ("workspace_id","table_id") REFERENCES "app"."workspace_data_tables"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_data_tables" ADD CONSTRAINT "workspace_data_tables_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_table_receipts_run_idx" ON "app"."data_table_write_receipts" USING btree ("workspace_id","run_id") WHERE run_id is not null;--> statement-breakpoint
CREATE INDEX "data_table_receipts_preview_idx" ON "app"."data_table_write_receipts" USING btree ("workspace_id","preview_run_id") WHERE preview_run_id is not null;--> statement-breakpoint
CREATE INDEX "workspace_data_table_rows_page" ON "app"."workspace_data_table_rows" USING btree ("workspace_id","table_id","id");
--> statement-breakpoint
ALTER TABLE app.workspace_data_table_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_data_table_quotas FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_data_table_quotas_workspace_scope ON app.workspace_data_table_quotas TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workspace_data_table_quotas_owner ON app.workspace_data_table_quotas TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workspace_data_table_quotas_maintenance ON app.workspace_data_table_quotas TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE ON app.workspace_data_table_quotas TO {{app_role}};
GRANT SELECT,DELETE ON app.workspace_data_table_quotas TO {{maintenance_role}};

--> statement-breakpoint
ALTER TABLE app.workspace_data_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_data_tables FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_data_tables_workspace_scope ON app.workspace_data_tables TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workspace_data_tables_owner ON app.workspace_data_tables TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workspace_data_tables_maintenance ON app.workspace_data_tables TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.workspace_data_tables TO {{app_role}};
GRANT SELECT,DELETE ON app.workspace_data_tables TO {{maintenance_role}};

--> statement-breakpoint
ALTER TABLE app.workspace_data_table_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_data_table_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_data_table_rows_workspace_scope ON app.workspace_data_table_rows TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workspace_data_table_rows_owner ON app.workspace_data_table_rows TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workspace_data_table_rows_maintenance ON app.workspace_data_table_rows TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.workspace_data_table_rows TO {{app_role}};
GRANT SELECT,DELETE ON app.workspace_data_table_rows TO {{maintenance_role}};

--> statement-breakpoint
ALTER TABLE app.data_table_write_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.data_table_write_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY data_table_write_receipts_workspace_scope ON app.data_table_write_receipts TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY data_table_write_receipts_owner ON app.data_table_write_receipts TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY data_table_write_receipts_maintenance ON app.data_table_write_receipts TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT ON app.data_table_write_receipts TO {{app_role}};
GRANT SELECT,DELETE ON app.data_table_write_receipts TO {{maintenance_role}};
