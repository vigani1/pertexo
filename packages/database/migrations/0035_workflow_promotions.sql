CREATE TABLE "app"."workflow_promotion_origins" (
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"source_workspace_id" uuid NOT NULL,
	"source_workflow_id" uuid NOT NULL,
	"source_version_id" uuid NOT NULL,
	"source_checksum" varchar(82) NOT NULL,
	"graph_digest" varchar(64) NOT NULL,
	"target_name" varchar(128) NOT NULL,
	"draft_revision" integer NOT NULL,
	"published_version_id" uuid,
	"promotion_id" uuid NOT NULL,
	"applied_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "workflow_promotion_origins_workspace_id_workflow_id_pk" PRIMARY KEY("workspace_id","workflow_id"),
	CONSTRAINT "promotion_origin_revision_positive" CHECK (draft_revision>0),
	CONSTRAINT "promotion_origin_digests_valid" CHECK (source_checksum ~ '^wf:sha256:[a-f0-9]{64}$' and graph_digest ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "promotion_origin_name_valid" CHECK (length(btrim(target_name)) between 1 and 128)
);
--> statement-breakpoint
CREATE TABLE "app"."workspace_promotion_targets" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"target_workspace_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "promotion_target_distinct" CHECK (workspace_id<>target_workspace_id),
	CONSTRAINT "promotion_target_revision_positive" CHECK (revision>0)
);
--> statement-breakpoint
CREATE TABLE "app"."workflow_version_promotions" (
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"source_workspace_id" uuid NOT NULL,
	"source_workflow_id" uuid NOT NULL,
	"source_version_id" uuid NOT NULL,
	"source_checksum" varchar(82) NOT NULL,
	"promotion_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "workflow_version_promotions_pk" PRIMARY KEY("workspace_id","version_id","source_workspace_id","source_workflow_id","source_version_id"),
	CONSTRAINT "version_promotion_checksum_valid" CHECK (source_checksum ~ '^wf:sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "app"."workflow_promotion_origins" ADD CONSTRAINT "promotion_origin_target_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "app"."workflows"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_promotion_targets" ADD CONSTRAINT "promotion_target_source_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_promotion_targets" ADD CONSTRAINT "promotion_target_destination_fk" FOREIGN KEY ("target_workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_promotion_targets" ADD CONSTRAINT "promotion_target_actor_fk" FOREIGN KEY ("updated_by") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_version_promotions" ADD CONSTRAINT "version_promotion_target_fk" FOREIGN KEY ("workspace_id","workflow_id","version_id") REFERENCES "app"."workflow_versions"("workspace_id","workflow_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_origin_source_unique" ON "app"."workflow_promotion_origins" USING btree ("workspace_id","source_workspace_id","source_workflow_id");--> statement-breakpoint
CREATE INDEX "version_promotion_source_idx" ON "app"."workflow_version_promotions" USING btree ("workspace_id","source_workspace_id","source_workflow_id","source_version_id");
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON app.workspace_promotion_targets,app.workflow_promotion_origins TO {{app_role}};
GRANT SELECT,INSERT ON app.workflow_version_promotions TO {{app_role}};
GRANT SELECT,DELETE ON app.workspace_promotion_targets,app.workflow_promotion_origins,app.workflow_version_promotions TO {{maintenance_role}};

--> statement-breakpoint
ALTER TABLE app.workspace_promotion_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_promotion_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY promotion_targets_workspace_scope ON app.workspace_promotion_targets TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY promotion_targets_owner ON app.workspace_promotion_targets TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY promotion_targets_maintenance ON app.workspace_promotion_targets TO {{maintenance_role}} USING (true) WITH CHECK (true);

--> statement-breakpoint
ALTER TABLE app.workflow_promotion_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_promotion_origins FORCE ROW LEVEL SECURITY;
CREATE POLICY promotion_origins_workspace_scope ON app.workflow_promotion_origins TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY promotion_origins_owner ON app.workflow_promotion_origins TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY promotion_origins_maintenance ON app.workflow_promotion_origins TO {{maintenance_role}} USING (true) WITH CHECK (true);

--> statement-breakpoint
ALTER TABLE app.workflow_version_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_version_promotions FORCE ROW LEVEL SECURITY;
CREATE POLICY version_promotions_workspace_scope ON app.workflow_version_promotions TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY version_promotions_owner ON app.workflow_version_promotions TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY version_promotions_maintenance ON app.workflow_version_promotions TO {{maintenance_role}} USING (true) WITH CHECK (true);

--> statement-breakpoint
-- Call admission shares table schema locks before accepting the child. PostgreSQL
-- requires UPDATE on a column for FOR SHARE; this grants no table-data writes.
GRANT UPDATE(id) ON app.workspace_data_tables TO {{maintenance_role}};
