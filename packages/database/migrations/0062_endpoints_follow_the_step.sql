-- product-ux-01: a webhook endpoint belongs to the workflow and its trigger step, so a publish
-- can't break it. ADR 069 (new SQL functions need a reason): the resolver and ingress limit stay
-- SECURITY DEFINER because they run before any workspace is known, and they are replaced rather
-- than extended since the old joins named endpoint.trigger_id.
ALTER TABLE "app"."webhook_trigger_endpoints" DROP CONSTRAINT "webhook_trigger_endpoints_trigger_id_key";--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_endpoints" DROP CONSTRAINT "webhook_trigger_endpoints_trigger_fk";--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_endpoints" DROP CONSTRAINT "webhook_trigger_endpoints_current_secret_fk";--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_endpoints" DROP CONSTRAINT "webhook_trigger_endpoints_previous_secret_fk";--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_deliveries" DROP CONSTRAINT "webhook_trigger_deliveries_trigger_fk";--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_secret_versions" DROP CONSTRAINT "webhook_trigger_secret_versions_trigger_identity_unique";--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_secret_versions" DROP CONSTRAINT "webhook_trigger_secret_versions_trigger_fk";--> statement-breakpoint
DROP INDEX "app"."webhook_trigger_deliveries_trigger_time_idx";--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_endpoints" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_endpoints" ADD COLUMN "node_id" varchar(128);--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_endpoints" ADD COLUMN "merged_into" uuid;--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_secret_versions" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_secret_versions" ADD COLUMN "node_id" varchar(128);--> statement-breakpoint
ALTER TABLE app.webhook_trigger_endpoints NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.webhook_trigger_secret_versions NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.webhook_trigger_deliveries NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.webhook_trigger_replay_records NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.webhook_endpoint_ingress_limits NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.trigger_coordinated_events NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.workflow_triggers NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.workflows NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.workspaces NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE app.webhook_trigger_endpoints endpoint
   SET workflow_id=trigger.workflow_id,node_id=trigger.node_id
  FROM app.workflow_triggers trigger
 WHERE trigger.workspace_id=endpoint.workspace_id AND trigger.id=endpoint.trigger_id;--> statement-breakpoint
UPDATE app.webhook_trigger_secret_versions secret
   SET workflow_id=trigger.workflow_id,node_id=trigger.node_id
  FROM app.workflow_triggers trigger
 WHERE trigger.workspace_id=secret.workspace_id AND trigger.id=secret.trigger_id;--> statement-breakpoint
-- Each publish used to retire the old row, so a step can hold several. One survives: the live
-- endpoint, otherwise the newest. Its address and secret are the ones a sender can still hold.
UPDATE app.webhook_trigger_endpoints endpoint
   SET merged_into=ranked.survivor
  FROM (SELECT id,first_value(id) OVER (
          PARTITION BY workspace_id,workflow_id,node_id
          ORDER BY (status='active') DESC,updated_at DESC,id) survivor
        FROM app.webhook_trigger_endpoints) ranked
 WHERE ranked.id=endpoint.id;--> statement-breakpoint
UPDATE app.webhook_trigger_deliveries delivery
   SET endpoint_id=endpoint.merged_into
  FROM app.webhook_trigger_endpoints endpoint
 WHERE endpoint.workspace_id=delivery.workspace_id AND endpoint.id=delivery.endpoint_id
   AND endpoint.merged_into<>endpoint.id;--> statement-breakpoint
UPDATE app.trigger_coordinated_events event
   SET endpoint_id=endpoint.merged_into
  FROM app.webhook_trigger_endpoints endpoint
 WHERE endpoint.workspace_id=event.workspace_id AND endpoint.id=event.endpoint_id
   AND endpoint.merged_into<>endpoint.id;--> statement-breakpoint
-- A retired address refused everything already, so its repeat records protect nothing.
DELETE FROM app.webhook_trigger_replay_records replay
 USING app.webhook_trigger_endpoints endpoint
 WHERE endpoint.workspace_id=replay.workspace_id AND endpoint.id=replay.endpoint_id
   AND endpoint.merged_into<>endpoint.id;--> statement-breakpoint
WITH retired AS (
  DELETE FROM app.webhook_trigger_endpoints WHERE merged_into<>id
  RETURNING workspace_id,trigger_id
)
DELETE FROM app.webhook_trigger_secret_versions secret
 USING retired
 WHERE secret.workspace_id=retired.workspace_id AND secret.trigger_id=retired.trigger_id;--> statement-breakpoint
-- An endpoint an earlier publish killed comes back, since nobody chose to stop it. Workspace
-- deletion is the only other thing that disables one, and it leaves the workspace inactive.
UPDATE app.webhook_trigger_endpoints endpoint
   SET status='active',updated_at=clock_timestamp()
  FROM app.workflows workflow
  JOIN app.workspaces workspace ON workspace.id=workflow.workspace_id
  JOIN app.workflow_triggers trigger
    ON trigger.workspace_id=workflow.workspace_id AND trigger.workflow_id=workflow.id
   AND trigger.workflow_version_id=workflow.published_version_id
 WHERE workflow.workspace_id=endpoint.workspace_id AND workflow.id=endpoint.workflow_id
   AND trigger.node_id=endpoint.node_id AND trigger.kind='webhook'
   AND workspace.status='active' AND endpoint.status='disabled';--> statement-breakpoint
UPDATE app.workflow_triggers trigger
   SET status='active',health_status='healthy',last_error_code=NULL,
       reconciled_at=clock_timestamp(),updated_at=clock_timestamp()
  FROM app.workflows workflow
  JOIN app.webhook_trigger_endpoints endpoint
    ON endpoint.workspace_id=workflow.workspace_id AND endpoint.workflow_id=workflow.id
 WHERE workflow.workspace_id=trigger.workspace_id AND workflow.id=trigger.workflow_id
   AND trigger.workflow_version_id=workflow.published_version_id
   AND trigger.kind='webhook' AND trigger.node_id=endpoint.node_id
   AND endpoint.status='active' AND trigger.status<>'active'
   AND workflow.lifecycle_status='active';--> statement-breakpoint
-- Same outcome as workflowActivationAfterReconciliation for a workflow with a usable trigger.
UPDATE app.workflows workflow
   SET activation_status=CASE WHEN EXISTS(
         SELECT 1 FROM app.workflow_triggers other
          WHERE other.workspace_id=workflow.workspace_id AND other.workflow_id=workflow.id
            AND other.workflow_version_id=workflow.published_version_id AND other.status<>'active'
       ) THEN 'degraded' ELSE 'active' END
 WHERE workflow.lifecycle_status='active' AND workflow.activation_status<>'active' AND EXISTS(
         SELECT 1 FROM app.workflow_triggers trigger
           JOIN app.webhook_trigger_endpoints endpoint
             ON endpoint.workspace_id=trigger.workspace_id AND endpoint.workflow_id=trigger.workflow_id
            AND endpoint.node_id=trigger.node_id
          WHERE trigger.workspace_id=workflow.workspace_id AND trigger.workflow_id=workflow.id
            AND trigger.workflow_version_id=workflow.published_version_id
            AND trigger.kind='webhook' AND trigger.status='active' AND endpoint.status='active');--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_endpoints" ALTER COLUMN "workflow_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_endpoints" ALTER COLUMN "node_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_secret_versions" ALTER COLUMN "workflow_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_secret_versions" ALTER COLUMN "node_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_endpoints" DROP COLUMN "merged_into";--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_deliveries" DROP COLUMN "trigger_id";--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_endpoints" DROP COLUMN "trigger_id";--> statement-breakpoint
ALTER TABLE "app"."workflow_triggers" ADD CONSTRAINT "workflow_triggers_step_identity_unique" UNIQUE("workspace_id","id","workflow_id","node_id");--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_endpoints" ADD CONSTRAINT "webhook_trigger_endpoints_step_unique" UNIQUE("workspace_id","workflow_id","node_id");--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_secret_versions" ADD CONSTRAINT "webhook_trigger_secret_versions_step_identity_unique" UNIQUE("workspace_id","workflow_id","node_id","id");--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_endpoints" ADD CONSTRAINT "webhook_trigger_endpoints_workflow_fk" FOREIGN KEY ("workspace_id","workflow_id") REFERENCES "app"."workflows"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_endpoints" ADD CONSTRAINT "webhook_trigger_endpoints_current_secret_fk" FOREIGN KEY ("workspace_id","workflow_id","node_id","current_secret_version_id") REFERENCES "app"."webhook_trigger_secret_versions"("workspace_id","workflow_id","node_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_endpoints" ADD CONSTRAINT "webhook_trigger_endpoints_previous_secret_fk" FOREIGN KEY ("workspace_id","workflow_id","node_id","previous_secret_version_id") REFERENCES "app"."webhook_trigger_secret_versions"("workspace_id","workflow_id","node_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_secret_versions" ADD CONSTRAINT "webhook_trigger_secret_versions_trigger_fk" FOREIGN KEY ("workspace_id","trigger_id","workflow_id","node_id") REFERENCES "app"."workflow_triggers"("workspace_id","id","workflow_id","node_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_trigger_deliveries_endpoint_time_idx" ON "app"."webhook_trigger_deliveries" USING btree ("workspace_id","endpoint_id","received_at" DESC NULLS FIRST,"id");--> statement-breakpoint
-- Back on only now: PostgreSQL validates a new foreign key under forced row security.
ALTER TABLE app.webhook_trigger_endpoints FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.webhook_trigger_secret_versions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.webhook_trigger_deliveries FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.webhook_trigger_replay_records FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.webhook_endpoint_ingress_limits FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.trigger_coordinated_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.workflow_triggers FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.workflows FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE app.workspaces FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP FUNCTION app.resolve_public_webhook_endpoint(character);--> statement-breakpoint
CREATE FUNCTION app.resolve_public_webhook_endpoint(p_endpoint_key_hash character) RETURNS TABLE(endpoint_id uuid, workspace_id uuid, trigger_id uuid, workflow_id uuid, workflow_version_id uuid, node_id character varying, current_secret_version_id uuid, current_secret_trigger_id uuid, current_kms_key_reference character varying, current_encrypted_data_key text, current_ciphertext text, current_nonce character varying, current_auth_tag character varying, previous_secret_version_id uuid, previous_secret_trigger_id uuid, previous_secret_valid_until timestamp with time zone, previous_kms_key_reference character varying, previous_encrypted_data_key text, previous_ciphertext text, previous_nonce character varying, previous_auth_tag character varying, database_time timestamp with time zone, authentication jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app'
    SET row_security TO 'on'
    AS $$
DECLARE
  resolved_workspace uuid;
  prior_workspace text;
BEGIN
  prior_workspace := current_setting('app.workspace_id',true);
  SELECT endpoint.workspace_id INTO resolved_workspace
    FROM app.webhook_trigger_endpoints endpoint
   WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash AND endpoint.status='active';
  IF resolved_workspace IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.workspace_id',resolved_workspace::text,true);
  -- The step in the published version answers, from the moment a publish commits. No trigger
  -- status is read: the worker's reconcile may not have run yet, and the endpoint's own status
  -- is what says whether it is live.
  RETURN QUERY SELECT endpoint.id,endpoint.workspace_id,trigger.id,trigger.workflow_id,
         trigger.workflow_version_id,trigger.node_id,current_secret.id,current_secret.trigger_id,
         current_secret.kms_key_reference,
         current_secret.encrypted_data_key,current_secret.ciphertext,current_secret.nonce,current_secret.auth_tag,
         previous_secret.id,previous_secret.trigger_id,endpoint.previous_secret_valid_until,
         previous_secret.kms_key_reference,
         previous_secret.encrypted_data_key,previous_secret.ciphertext,previous_secret.nonce,previous_secret.auth_tag,
         clock_timestamp(),endpoint.authentication
    FROM app.webhook_trigger_endpoints endpoint
    JOIN app.workflows workflow ON workflow.workspace_id=endpoint.workspace_id AND workflow.id=endpoint.workflow_id
    JOIN app.workflow_triggers trigger
      ON trigger.workspace_id=endpoint.workspace_id AND trigger.workflow_id=endpoint.workflow_id
     AND trigger.node_id=endpoint.node_id AND trigger.workflow_version_id=workflow.published_version_id
    JOIN app.workspaces workspace ON workspace.id=endpoint.workspace_id
    JOIN app.webhook_trigger_secret_versions current_secret
      ON current_secret.workspace_id=endpoint.workspace_id AND current_secret.id=endpoint.current_secret_version_id
    LEFT JOIN app.webhook_trigger_secret_versions previous_secret
      ON previous_secret.workspace_id=endpoint.workspace_id AND previous_secret.id=endpoint.previous_secret_version_id
     AND endpoint.previous_secret_valid_until>clock_timestamp()
   WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash AND endpoint.status='active'
     AND trigger.kind='webhook' AND workflow.lifecycle_status='active'
     AND workspace.status='active';
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.resolve_public_webhook_endpoint(character) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_public_webhook_endpoint(character) TO {{app_role}};--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.consume_webhook_ingress_limit(p_endpoint_key_hash character) RETURNS TABLE(allowed boolean, retry_after_seconds integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app', 'pg_temp'
    SET row_security TO 'on'
    AS $$
DECLARE
  v_endpoint_id uuid;
  v_workspace_id uuid;
  v_now timestamptz := clock_timestamp();
  v_started timestamptz;
  v_count integer;
BEGIN
  SELECT endpoint.id,endpoint.workspace_id INTO v_endpoint_id,v_workspace_id
    FROM app.webhook_trigger_endpoints endpoint
   WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash AND endpoint.status='active';
  IF v_endpoint_id IS NULL THEN RETURN QUERY SELECT false,1; RETURN; END IF;

  INSERT INTO app.webhook_endpoint_ingress_limits
    (endpoint_id,workspace_id,bucket_started_at,request_count)
    VALUES(v_endpoint_id,v_workspace_id,v_now,1)
    ON CONFLICT(endpoint_id) DO NOTHING;
  IF FOUND THEN RETURN QUERY SELECT true,0; RETURN; END IF;
  SELECT bucket_started_at,request_count INTO v_started,v_count
    FROM app.webhook_endpoint_ingress_limits WHERE endpoint_id=v_endpoint_id FOR UPDATE;
  IF v_started+interval '1 minute'<=v_now THEN
    UPDATE app.webhook_endpoint_ingress_limits SET bucket_started_at=v_now,
      request_count=1,updated_at=v_now WHERE endpoint_id=v_endpoint_id;
    RETURN QUERY SELECT true,0; RETURN;
  END IF;
  IF v_count>=60 THEN
    RETURN QUERY SELECT false,greatest(1,least(60,
      ceil(extract(epoch FROM (v_started+interval '1 minute'-v_now)))::integer));
    RETURN;
  END IF;
  UPDATE app.webhook_endpoint_ingress_limits SET request_count=request_count+1,
    updated_at=v_now WHERE endpoint_id=v_endpoint_id;
  RETURN QUERY SELECT true,0;
END $$;
