CREATE TABLE "app"."trigger_coordinated_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"node_id" varchar(128) NOT NULL,
	"source" varchar(16) NOT NULL,
	"mode" varchar(16) NOT NULL,
	"initial_outcome" varchar(16) NOT NULL,
	"status" varchar(16) NOT NULL,
	"initial_status" varchar(16) NOT NULL,
	"reason" varchar(32),
	"run_id" uuid,
	"version_number" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT clock_timestamp()+interval '90 days' NOT NULL,
	"finished_at" timestamp with time zone,
	"key_id" uuid,
	"workflow_version_id" uuid,
	"endpoint_id" uuid,
	"policy" jsonb,
	"input_ref" jsonb,
	"input_bytes" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"capacity_wait_started_at" timestamp with time zone,
	"started_by" uuid,
	CONSTRAINT "trigger_coordinated_events_identity" UNIQUE("workspace_id","id"),
	CONSTRAINT "trigger_coordinated_events_kind" CHECK (source in ('webhook','form') and mode in ('deduplicate','debounce','throttle') and initial_outcome in ('accepted','skipped','deduplicated','debounced','throttled','refused') and initial_status in ('pending','started','skipped','refused') and status in ('pending','started','skipped','coalesced','refused') and (reason is null or reason in ('duplicate_key','newer_event','throttle_limit','invalid_key','coordination_full','coordination_timeout','queue_full','concurrency_limit','workflow_unavailable','publication_changed','endpoint_disabled')) and version_number>0),
	CONSTRAINT "trigger_coordinated_events_state" CHECK (((status='pending' and key_id is not null and workflow_version_id is not null and policy is not null and input_ref is not null and input_ref->>'kind'='inline' and octet_length(input_ref::text)<=4194304 and octet_length(policy::text)<=65536 and input_bytes between 1 and 262144 and due_at is not null and deadline_at is not null and finished_at is null and run_id is null and ((source='webhook')=(endpoint_id is not null))) or (status<>'pending' and key_id is null and workflow_version_id is null and endpoint_id is null and policy is null and input_ref is null and input_bytes=0 and due_at is null and deadline_at is null and capacity_wait_started_at is null and started_by is null and finished_at is not null)) and ((status='started')=(run_id is not null))),
	CONSTRAINT "trigger_coordinated_events_retention" CHECK (expires_at between received_at+interval '89 days 23:59:59' and received_at+interval '90 days 00:00:01')
);
--> statement-breakpoint
CREATE TABLE "app"."trigger_event_windows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"node_id" varchar(128) NOT NULL,
	"policy_hash" char(64) NOT NULL,
	"key_hash" char(64) NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trigger_event_windows_identity" UNIQUE("workspace_id","id"),
	CONSTRAINT "trigger_event_windows_key" UNIQUE("workspace_id","workflow_id","node_id","policy_hash","key_hash"),
	CONSTRAINT "trigger_event_windows_bounds" CHECK (policy_hash ~ '^[0-9a-f]{64}$' and key_hash ~ '^[0-9a-f]{64}$' and used_count between 0 and 1000 and expires_at>window_started_at)
);
--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_deliveries" DROP CONSTRAINT "webhook_trigger_deliveries_outcome_valid";--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_deliveries" ADD COLUMN "coordination_event_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_replay_records" ADD COLUMN "coordination_event_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."trigger_coordinated_events" ADD CONSTRAINT "trigger_coordinated_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."trigger_coordinated_events" ADD CONSTRAINT "trigger_coordinated_events_workspace_id_workflow_id_workflows_workspace_id_id_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "app"."workflows"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."trigger_coordinated_events" ADD CONSTRAINT "trigger_coordinated_events_workspace_id_key_id_trigger_event_windows_workspace_id_id_fk" FOREIGN KEY ("workspace_id","key_id") REFERENCES "app"."trigger_event_windows"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."trigger_coordinated_events" ADD CONSTRAINT "trigger_coordinated_events_workspace_id_workflow_version_id_workflow_versions_workspace_id_id_fk" FOREIGN KEY ("workspace_id","workflow_version_id") REFERENCES "app"."workflow_versions"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."trigger_coordinated_events" ADD CONSTRAINT "trigger_coordinated_events_workspace_id_endpoint_id_webhook_trigger_endpoints_workspace_id_id_fk" FOREIGN KEY ("workspace_id","endpoint_id") REFERENCES "app"."webhook_trigger_endpoints"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."trigger_coordinated_events" ADD CONSTRAINT "trigger_coordinated_events_workspace_id_run_id_workflow_runs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "app"."workflow_runs"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."trigger_event_windows" ADD CONSTRAINT "trigger_event_windows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."trigger_event_windows" ADD CONSTRAINT "trigger_event_windows_workspace_id_workflow_id_workflows_workspace_id_id_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "app"."workflows"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trigger_coordinated_events_history" ON "app"."trigger_coordinated_events" USING btree ("workspace_id","workflow_id","node_id","received_at","id");--> statement-breakpoint
CREATE INDEX "trigger_coordinated_events_expiry" ON "app"."trigger_coordinated_events" USING btree ("expires_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_coordinated_events_debounce" ON "app"."trigger_coordinated_events" USING btree ("key_id") WHERE status='pending' and mode='debounce';--> statement-breakpoint
CREATE INDEX "trigger_coordinated_events_due" ON "app"."trigger_coordinated_events" USING btree ("due_at","id") WHERE status='pending';--> statement-breakpoint
CREATE INDEX "trigger_coordinated_events_head" ON "app"."trigger_coordinated_events" USING btree ("key_id","received_at","id") WHERE status='pending';--> statement-breakpoint
CREATE INDEX "trigger_coordinated_events_budget" ON "app"."trigger_coordinated_events" USING btree ("workspace_id") WHERE status='pending';--> statement-breakpoint
CREATE INDEX "trigger_coordinated_events_run" ON "app"."trigger_coordinated_events" USING btree ("workspace_id","run_id") WHERE run_id is not null;--> statement-breakpoint
CREATE INDEX "trigger_event_windows_expiry" ON "app"."trigger_event_windows" USING btree ("workspace_id","expires_at");--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_deliveries" ADD CONSTRAINT "webhook_trigger_deliveries_workspace_id_coordination_event_id_trigger_coordinated_events_workspace_id_id_fk" FOREIGN KEY ("workspace_id","coordination_event_id") REFERENCES "app"."trigger_coordinated_events"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_replay_records" ADD CONSTRAINT "webhook_trigger_replay_records_workspace_id_coordination_event_id_trigger_coordinated_events_workspace_id_id_fk" FOREIGN KEY ("workspace_id","coordination_event_id") REFERENCES "app"."trigger_coordinated_events"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_events_coordinated_history_idx" ON "app"."usage_events" USING btree ("workspace_id","occurred_at","id") WHERE category='trigger.coordinated';--> statement-breakpoint
CREATE INDEX "usage_events_coordinated_retention_idx" ON "app"."usage_events" USING btree ("occurred_at","id") WHERE category='trigger.coordinated';--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_deliveries" ADD CONSTRAINT "webhook_trigger_deliveries_outcome_valid" CHECK ((((outcome='coordinated' and http_status=202 and signature_check='verified' and replay_check in ('new','duplicate') and workflow_run_id is null and dedupe_kind is not null and skip_reason is null and coordination_event_id is not null) OR (outcome='skipped' AND http_status=202 AND signature_check='verified' AND replay_check IN ('new','duplicate') AND workflow_run_id IS NULL AND dedupe_kind IS NOT NULL AND skip_reason='concurrency_limit') OR (skip_reason IS NULL AND ((((outcome)::text = 'accepted'::text) AND (http_status = 202) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text) AND (workflow_run_id IS NOT NULL) AND (dedupe_kind IS NOT NULL)) OR (((outcome)::text = 'replayed'::text) AND (http_status = 202) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'duplicate'::text) AND (workflow_run_id IS NOT NULL) AND (dedupe_kind IS NOT NULL)) OR ((workflow_run_id IS NULL) AND ((((outcome)::text = 'authentication_failed'::text) AND (http_status = 401) AND ((((signature_check)::text = 'not_checked'::text) AND ((replay_check)::text = 'stale_timestamp'::text)) OR (((signature_check)::text = 'mismatch'::text) AND ((replay_check)::text = 'not_checked'::text)) OR (((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text)))) OR (((outcome)::text = 'invalid_request'::text) AND (http_status = 400) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'not_checked'::text)) OR (((outcome)::text = 'conflict'::text) AND (http_status = 409) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'conflict'::text)) OR (((outcome)::text = 'rate_limited'::text) AND (http_status = 429) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text)) OR (((outcome)::text = 'paused'::text) AND (http_status = 423) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text)))))))) IS TRUE);
--> statement-breakpoint
ALTER TABLE app.trigger_event_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.trigger_event_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY trigger_event_windows_workspace_scope ON app.trigger_event_windows TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY trigger_event_windows_owner ON app.trigger_event_windows TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY trigger_event_windows_maintenance ON app.trigger_event_windows TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON app.trigger_event_windows TO {{app_role}};
GRANT SELECT,DELETE ON app.trigger_event_windows TO {{maintenance_role}};

--> statement-breakpoint
ALTER TABLE app.trigger_coordinated_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.trigger_coordinated_events FORCE ROW LEVEL SECURITY;
CREATE POLICY trigger_coordinated_events_workspace_scope ON app.trigger_coordinated_events TO {{app_role}}
 USING (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''))
 WITH CHECK (workspace_id::text=NULLIF(current_setting('app.workspace_id',true),''));
CREATE POLICY trigger_coordinated_events_owner ON app.trigger_coordinated_events TO {{owner_role}} USING (true) WITH CHECK (true);
CREATE POLICY trigger_coordinated_events_maintenance ON app.trigger_coordinated_events TO {{maintenance_role}} USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE ON app.trigger_coordinated_events TO {{app_role}};
GRANT SELECT,DELETE ON app.trigger_coordinated_events TO {{maintenance_role}};

--> statement-breakpoint
-- Global discovery returns identities only; decisions and admission run under workspace RLS.
CREATE FUNCTION app.discover_due_coordinated_events(p_limit integer)
RETURNS TABLE(workspace_id uuid,event_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET row_security=on
AS $function$
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN
   RAISE EXCEPTION 'Invalid coordination discovery limit' USING ERRCODE='22023';
 END IF;
 RETURN QUERY
 WITH heads AS MATERIALIZED (
   SELECT DISTINCT ON (event.key_id) event.workspace_id,event.id,event.due_at
   FROM app.trigger_coordinated_events event
   WHERE event.status='pending'
   ORDER BY event.key_id,event.received_at,event.id
 ), due AS (
   SELECT head.workspace_id,head.id,head.due_at,
     row_number() OVER (PARTITION BY head.workspace_id ORDER BY head.due_at,head.id) workspace_rank
   FROM heads head WHERE head.due_at<=clock_timestamp()
 ) SELECT due.workspace_id,due.id FROM due ORDER BY due.workspace_rank,due.due_at,due.id LIMIT p_limit;
END;
$function$;
REVOKE ALL ON FUNCTION app.discover_due_coordinated_events(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.discover_due_coordinated_events(integer) TO {{app_role}};
--> statement-breakpoint
GRANT UPDATE(coordination_event_id) ON app.webhook_trigger_replay_records TO {{app_role}};
