ALTER TABLE "app"."run_error_workflow_intents" DROP CONSTRAINT "run_error_workflow_intents_state_valid";--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_deliveries" DROP CONSTRAINT "webhook_trigger_deliveries_outcome_valid";--> statement-breakpoint
ALTER TABLE "app"."workflow_concurrency_policies" ADD COLUMN "overflow" varchar(8) DEFAULT 'queue' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."trigger_schedule_occurrences" ADD COLUMN "skip_reason" varchar(32);--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_deliveries" ADD COLUMN "skip_reason" varchar(32);--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_replay_records" ADD COLUMN "skip_reason" varchar(32);--> statement-breakpoint
CREATE INDEX "usage_events_trigger_skip_history_idx" ON "app"."usage_events" USING btree ("workspace_id","resource_id","occurred_at" DESC NULLS LAST,"id") WHERE category='trigger.skipped' AND resource_type='workflow';--> statement-breakpoint
CREATE INDEX "usage_events_trigger_skip_retention_idx" ON "app"."usage_events" USING btree ("occurred_at","id") WHERE category='trigger.skipped';--> statement-breakpoint
ALTER TABLE "app"."workflow_concurrency_policies" ADD CONSTRAINT "workflow_concurrency_policies_overflow_check" CHECK (overflow IN ('queue','skip'));--> statement-breakpoint
ALTER TABLE "app"."run_error_workflow_intents" ADD CONSTRAINT "run_error_workflow_intents_state_valid" CHECK (((status = 'pending' AND accepted_run_id IS NULL AND refusal_code IS NULL AND completed_at IS NULL) OR (status = 'accepted' AND accepted_run_id IS NOT NULL AND refusal_code IS NULL AND completed_at IS NOT NULL) OR (status = 'refused' AND accepted_run_id IS NULL AND refusal_code IN ('target_unavailable','workspace_unavailable','queue_full','invalid_target','target_not_published','concurrency_limit') AND completed_at IS NOT NULL)) IS TRUE);--> statement-breakpoint
ALTER TABLE "app"."trigger_schedule_occurrences" ADD CONSTRAINT "schedule_occurrence_skip_valid" CHECK (skip_reason IS NULL OR (skip_reason='concurrency_limit' AND disposition='skipped' AND workflow_run_id IS NULL));--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_deliveries" ADD CONSTRAINT "webhook_trigger_deliveries_outcome_valid" CHECK ((((outcome='skipped' AND http_status=202 AND signature_check='verified' AND replay_check IN ('new','duplicate') AND workflow_run_id IS NULL AND dedupe_kind IS NOT NULL AND skip_reason='concurrency_limit') OR (skip_reason IS NULL AND ((((outcome)::text = 'accepted'::text) AND (http_status = 202) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text) AND (workflow_run_id IS NOT NULL) AND (dedupe_kind IS NOT NULL)) OR (((outcome)::text = 'replayed'::text) AND (http_status = 202) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'duplicate'::text) AND (workflow_run_id IS NOT NULL) AND (dedupe_kind IS NOT NULL)) OR ((workflow_run_id IS NULL) AND ((((outcome)::text = 'authentication_failed'::text) AND (http_status = 401) AND ((((signature_check)::text = 'not_checked'::text) AND ((replay_check)::text = 'stale_timestamp'::text)) OR (((signature_check)::text = 'mismatch'::text) AND ((replay_check)::text = 'not_checked'::text)) OR (((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text)))) OR (((outcome)::text = 'invalid_request'::text) AND (http_status = 400) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'not_checked'::text)) OR (((outcome)::text = 'conflict'::text) AND (http_status = 409) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'conflict'::text)) OR (((outcome)::text = 'rate_limited'::text) AND (http_status = 429) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text)) OR (((outcome)::text = 'paused'::text) AND (http_status = 423) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text)))))))) IS TRUE);--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_replay_records" ADD CONSTRAINT "webhook_replay_skip_valid" CHECK (skip_reason IS NULL OR (skip_reason='concurrency_limit' AND workflow_run_id IS NULL));--> statement-breakpoint
-- Only a compatible TypeScript admission owner may accept under Skip. The
-- existing admission trigger acquires the workspace counter before this fence.
CREATE FUNCTION app.require_workflow_skip_protocol() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog','app' SET row_security TO 'on'
AS $$
BEGIN
  IF current_setting('app.workflow_concurrency_skip_protocol',true) IS DISTINCT FROM '1'
    AND EXISTS(SELECT 1 FROM app.workflow_concurrency_policies
      WHERE workspace_id=NEW.workspace_id AND workflow_id=NEW.workflow_id
        AND active_run_limit IS NOT NULL AND overflow='skip') THEN
    RAISE EXCEPTION 'workflow skip admission protocol required' USING ERRCODE='PTC01';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.require_workflow_skip_protocol() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.require_workflow_skip_protocol() TO {{app_role}},{{maintenance_role}};
CREATE TRIGGER workflow_run_skip_protocol BEFORE INSERT ON app.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION app.require_workflow_skip_protocol();
GRANT UPDATE(overflow) ON app.workflow_concurrency_policies TO {{app_role}};
GRANT UPDATE(skip_reason) ON app.webhook_trigger_replay_records TO {{app_role}};
