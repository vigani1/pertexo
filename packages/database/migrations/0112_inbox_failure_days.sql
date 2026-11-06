CREATE TABLE "app"."workspace_inbox_failure_days" (
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"day" date NOT NULL,
	"count" bigint NOT NULL,
	CONSTRAINT "workspace_inbox_failure_days_workspace_id_workflow_id_day_pk" PRIMARY KEY("workspace_id","workflow_id","day"),
	CONSTRAINT "workspace_inbox_failure_days_count_positive" CHECK (count>0)
);
--> statement-breakpoint
ALTER TABLE "app"."workspace_inbox_failure_days" ADD CONSTRAINT "workspace_inbox_failure_days_workspace_id_workflow_id_workflows_workspace_id_id_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "app"."workflows"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_inbox_failure_days_expiry_idx" ON "app"."workspace_inbox_failure_days" USING btree ("day","workspace_id","workflow_id");--> statement-breakpoint
ALTER TABLE app.workspace_inbox_failure_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_inbox_failure_days FORCE ROW LEVEL SECURITY;
CREATE POLICY inbox_failure_days_read ON app.workspace_inbox_failure_days FOR SELECT TO {{app_role}} USING(workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY inbox_failure_days_write ON app.workspace_inbox_failure_days FOR ALL TO {{app_role}} USING(workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'') AND NULLIF(current_setting('app.actor_id',true),'') IS NULL) WITH CHECK(workspace_id::text=NULLIF(current_setting('app.workspace_id',true),'') AND NULLIF(current_setting('app.actor_id',true),'') IS NULL);
CREATE POLICY inbox_failure_days_owner ON app.workspace_inbox_failure_days TO {{owner_role}} USING(true) WITH CHECK(true);
CREATE POLICY inbox_failure_days_maintenance ON app.workspace_inbox_failure_days TO {{maintenance_role}} USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.workspace_inbox_failure_days TO {{app_role}},{{maintenance_role}};
--> statement-breakpoint
-- Upgrades run with writers stopped; the backfill preserves already retained history.
LOCK TABLE app.workflow_runs IN SHARE MODE;
INSERT INTO app.workspace_inbox_failure_days(workspace_id,workflow_id,day,count)
SELECT workspace_id,workflow_id,(completed_at AT TIME ZONE 'UTC')::date,count(*)
FROM app.workflow_runs
WHERE trigger_type<>'test' AND status IN ('failed','timed_out','outcome_unknown')
  AND completed_at>=(date_trunc('day',statement_timestamp() AT TIME ZONE 'UTC')-interval '29 days') AT TIME ZONE 'UTC'
  AND completed_at<=statement_timestamp()
GROUP BY workspace_id,workflow_id,(completed_at AT TIME ZONE 'UTC')::date;
