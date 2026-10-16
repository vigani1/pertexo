ALTER TABLE "app"."webhook_run_responses" DROP CONSTRAINT "webhook_run_responses_complete";--> statement-breakpoint
ALTER TABLE "app"."webhook_trigger_endpoints" ADD COLUMN "authentication" jsonb DEFAULT '{"mode":"signed","allowedOrigins":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."webhook_run_responses" ADD CONSTRAINT "webhook_run_responses_complete" CHECK (((responded_at IS NULL AND status_code IS NULL AND content_type IS NULL AND headers IS NULL AND body IS NULL AND node_run_id IS NULL AND invocation_key IS NULL) OR (responded_at IS NOT NULL AND status_code BETWEEN 200 AND 599 AND content_type IN ('application/json','text/plain','text/csv','application/xml') AND headers IS NOT NULL AND jsonb_typeof(headers)='object' AND body IS NOT NULL AND node_run_id IS NOT NULL AND invocation_key IS NOT NULL)) IS TRUE);
--> statement-breakpoint
DROP FUNCTION app.resolve_public_webhook_endpoint(character);
CREATE FUNCTION app.resolve_public_webhook_endpoint(p_endpoint_key_hash character) RETURNS TABLE(endpoint_id uuid, workspace_id uuid, trigger_id uuid, workflow_id uuid, workflow_version_id uuid, node_id character varying, current_secret_version_id uuid, current_kms_key_reference character varying, current_encrypted_data_key text, current_ciphertext text, current_nonce character varying, current_auth_tag character varying, previous_secret_version_id uuid, previous_secret_valid_until timestamp with time zone, previous_kms_key_reference character varying, previous_encrypted_data_key text, previous_ciphertext text, previous_nonce character varying, previous_auth_tag character varying, database_time timestamp with time zone, authentication jsonb)
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
    JOIN app.workflow_triggers trigger
      ON trigger.workspace_id=endpoint.workspace_id AND trigger.id=endpoint.trigger_id
   WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash
     AND endpoint.status='active' AND trigger.kind='webhook' AND trigger.status='active';
  IF resolved_workspace IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.workspace_id',resolved_workspace::text,true);
  RETURN QUERY SELECT endpoint.id,endpoint.workspace_id,trigger.id,trigger.workflow_id,
         trigger.workflow_version_id,trigger.node_id,current_secret.id,
         current_secret.kms_key_reference,
         current_secret.encrypted_data_key,current_secret.ciphertext,current_secret.nonce,current_secret.auth_tag,
         previous_secret.id,endpoint.previous_secret_valid_until,
         previous_secret.kms_key_reference,
         previous_secret.encrypted_data_key,previous_secret.ciphertext,previous_secret.nonce,previous_secret.auth_tag,
         clock_timestamp(),endpoint.authentication
    FROM app.webhook_trigger_endpoints endpoint
    JOIN app.workflow_triggers trigger ON trigger.workspace_id=endpoint.workspace_id AND trigger.id=endpoint.trigger_id
    JOIN app.workflows workflow ON workflow.workspace_id=trigger.workspace_id AND workflow.id=trigger.workflow_id
    JOIN app.workspaces workspace ON workspace.id=trigger.workspace_id
    JOIN app.webhook_trigger_secret_versions current_secret
      ON current_secret.workspace_id=endpoint.workspace_id AND current_secret.trigger_id=trigger.id
     AND current_secret.id=endpoint.current_secret_version_id
    LEFT JOIN app.webhook_trigger_secret_versions previous_secret
      ON previous_secret.workspace_id=endpoint.workspace_id AND previous_secret.trigger_id=trigger.id
     AND previous_secret.id=endpoint.previous_secret_version_id
     AND endpoint.previous_secret_valid_until>clock_timestamp()
   WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash AND endpoint.status='active'
     AND trigger.kind='webhook' AND trigger.status='active'
     AND workflow.lifecycle_status='active' AND workflow.activation_status IN ('active','degraded')
     AND workflow.published_version_id=trigger.workflow_version_id
     AND workspace.status='active';
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END $$;


REVOKE ALL ON FUNCTION app.resolve_public_webhook_endpoint(character) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_public_webhook_endpoint(character) TO {{app_role}};

GRANT UPDATE(authentication) ON app.webhook_trigger_endpoints TO {{app_role}};
