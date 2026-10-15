CREATE TABLE "app"."workspace_variable_set_revisions" (
	"workspace_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"values_json" jsonb NOT NULL,
	"descriptions_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "workspace_variable_set_revisions_workspace_id_revision_pk" PRIMARY KEY("workspace_id","revision"),
	CONSTRAINT "workspace_variable_sets_revision_positive" CHECK (revision>0),
	CONSTRAINT "workspace_variable_sets_values_bounded" CHECK (jsonb_typeof(values_json)='object' AND octet_length(values_json::text)<=65536),
	CONSTRAINT "workspace_variable_sets_descriptions_bounded" CHECK (jsonb_typeof(descriptions_json)='object' AND octet_length(descriptions_json::text)<=32768)
);
--> statement-breakpoint
-- Readers are stopped: preserve every retained captured set before dropping copies.
DO $$
BEGIN
  IF EXISTS (with snapshots as (
    select workspace_id,revision,values_json from app.workspace_variables
    union all
    select workspace_id,(variable_snapshot->>'revision')::integer,variable_snapshot->'values'
      from app.workflow_runs where variable_snapshot is not null
    union all
    select workspace_id,(variable_snapshot->>'revision')::integer,variable_snapshot->'values'
      from app.preview_runs where variable_snapshot is not null
  ) select 1 from snapshots where revision is null or revision<0
    or jsonb_typeof(values_json) is distinct from 'object'
    or (revision=0 and values_json is distinct from '{}'::jsonb)) THEN
    RAISE EXCEPTION 'Stored workspace variable snapshots do not have a valid revision and value map';
  END IF;
  IF EXISTS (with snapshots as (
    select workspace_id,revision,values_json from app.workspace_variables
    union all
    select workspace_id,(variable_snapshot->>'revision')::integer,variable_snapshot->'values'
      from app.workflow_runs where variable_snapshot is not null
    union all
    select workspace_id,(variable_snapshot->>'revision')::integer,variable_snapshot->'values'
      from app.preview_runs where variable_snapshot is not null
  ) select 1 from snapshots group by workspace_id,revision
    having count(distinct values_json)>1) THEN
    RAISE EXCEPTION 'Stored workspace variable snapshots disagree for the same workspace revision';
  END IF;
END $$;
--> statement-breakpoint
with snapshots as (
  select workspace_id,revision,values_json from app.workspace_variables
    union all
    select workspace_id,(variable_snapshot->>'revision')::integer,variable_snapshot->'values'
      from app.workflow_runs where variable_snapshot is not null
    union all
    select workspace_id,(variable_snapshot->>'revision')::integer,variable_snapshot->'values'
      from app.preview_runs where variable_snapshot is not null
) insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json)
  select distinct workspace_id,revision,values_json from snapshots where revision>0;
--> statement-breakpoint
ALTER TABLE "app"."workspace_variables" DROP CONSTRAINT "workspace_variables_values_bounded";--> statement-breakpoint
ALTER TABLE "app"."preview_runs" DROP CONSTRAINT "preview_runs_variable_snapshot_valid";--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" DROP CONSTRAINT "workflow_runs_variable_snapshot_valid";--> statement-breakpoint
ALTER TABLE "app"."preview_runs" ADD COLUMN "variable_set_revision" integer;--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD COLUMN "variable_set_revision" integer;--> statement-breakpoint
UPDATE app.workflow_runs SET variable_set_revision=nullif((variable_snapshot->>'revision')::integer,0)
 WHERE variable_snapshot IS NOT NULL;
--> statement-breakpoint
-- The owner can inventory previews globally but normally updates only a scoped workspace.
-- This transaction holds the table lock and restores FORCE immediately after backfill.
ALTER TABLE app.preview_runs NO FORCE ROW LEVEL SECURITY;
UPDATE app.preview_runs SET variable_set_revision=nullif((variable_snapshot->>'revision')::integer,0);
ALTER TABLE app.preview_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."workspace_variable_set_revisions" ADD CONSTRAINT "workspace_variable_sets_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_variables" ADD CONSTRAINT "workspace_variables_set_fk" FOREIGN KEY ("workspace_id","revision") REFERENCES "app"."workspace_variable_set_revisions"("workspace_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."preview_runs" ADD CONSTRAINT "preview_runs_variable_set_fk" FOREIGN KEY ("workspace_id","variable_set_revision") REFERENCES "app"."workspace_variable_set_revisions"("workspace_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD CONSTRAINT "workflow_runs_variable_set_fk" FOREIGN KEY ("workspace_id","variable_set_revision") REFERENCES "app"."workspace_variable_set_revisions"("workspace_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "preview_runs_variable_set_idx" ON "app"."preview_runs" USING btree ("workspace_id","variable_set_revision") WHERE variable_set_revision IS NOT NULL;--> statement-breakpoint
CREATE INDEX "workflow_runs_variable_set_idx" ON "app"."workflow_runs" USING btree ("workspace_id","variable_set_revision") WHERE variable_set_revision IS NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workspace_variables" DROP COLUMN "values_json";--> statement-breakpoint
ALTER TABLE "app"."preview_runs" DROP COLUMN "variable_snapshot";--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" DROP COLUMN "variable_snapshot";--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD CONSTRAINT "workflow_runs_variable_set_retention" CHECK (details_purged_at IS NULL OR variable_set_revision IS NULL);
--> statement-breakpoint
ALTER TABLE app.workspace_variable_set_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_variable_set_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_variable_sets_workspace_scope ON app.workspace_variable_set_revisions TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY workspace_variable_sets_owner ON app.workspace_variable_set_revisions TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY workspace_variable_sets_maintenance ON app.workspace_variable_set_revisions TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT ON app.workspace_variable_set_revisions TO {{app_role}};
-- PostgreSQL row locks need UPDATE on one column; values and descriptions remain immutable.
GRANT SELECT,DELETE,UPDATE(created_at) ON app.workspace_variable_set_revisions TO {{maintenance_role}};
GRANT UPDATE(variable_set_revision) ON app.workflow_runs TO {{maintenance_role}};
