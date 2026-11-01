DROP FUNCTION app.resolve_public_webhook_endpoint(character);--> statement-breakpoint
CREATE FUNCTION app.resolve_public_webhook_endpoint(p_endpoint_key_hash character) RETURNS TABLE(endpoint_id uuid, workspace_id uuid, trigger_id uuid, workflow_id uuid, workflow_version_id uuid, node_id character varying, current_secret_version_id uuid, current_secret_trigger_id uuid, current_kms_key_reference character varying, current_encrypted_data_key text, current_ciphertext text, current_nonce character varying, current_auth_tag character varying, previous_secret_version_id uuid, previous_secret_trigger_id uuid, previous_secret_valid_until timestamp with time zone, previous_kms_key_reference character varying, previous_encrypted_data_key text, previous_ciphertext text, previous_nonce character varying, previous_auth_tag character varying, database_time timestamp with time zone, authentication jsonb, endpoint_status character varying, workflow_lifecycle_status character varying, workspace_status character varying)
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
   WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash;
  IF resolved_workspace IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.workspace_id',resolved_workspace::text,true);
  -- A door around row security: it finds the step this address answers for, from the moment a
  -- publish commits, and reports the statuses. Whether they let a delivery in is core's rule
  -- (triggers/webhooks/runtime/endpoint-rules.ts), used here and again under the admission locks.
  RETURN QUERY SELECT endpoint.id,endpoint.workspace_id,trigger.id,trigger.workflow_id,
         trigger.workflow_version_id,trigger.node_id,current_secret.id,current_secret.trigger_id,
         current_secret.kms_key_reference,
         current_secret.encrypted_data_key,current_secret.ciphertext,current_secret.nonce,current_secret.auth_tag,
         previous_secret.id,previous_secret.trigger_id,endpoint.previous_secret_valid_until,
         previous_secret.kms_key_reference,
         previous_secret.encrypted_data_key,previous_secret.ciphertext,previous_secret.nonce,previous_secret.auth_tag,
         clock_timestamp(),endpoint.authentication,
         endpoint.status,workflow.lifecycle_status,workspace.status
    FROM app.webhook_trigger_endpoints endpoint
    JOIN app.workflows workflow ON workflow.workspace_id=endpoint.workspace_id AND workflow.id=endpoint.workflow_id
    JOIN app.workflow_triggers trigger
      ON trigger.workspace_id=endpoint.workspace_id AND trigger.workflow_id=endpoint.workflow_id
     AND trigger.node_id=endpoint.node_id AND trigger.workflow_version_id=workflow.published_version_id
     AND trigger.kind='webhook'
    JOIN app.workspaces workspace ON workspace.id=endpoint.workspace_id
    JOIN app.webhook_trigger_secret_versions current_secret
      ON current_secret.workspace_id=endpoint.workspace_id AND current_secret.id=endpoint.current_secret_version_id
    LEFT JOIN app.webhook_trigger_secret_versions previous_secret
      ON previous_secret.workspace_id=endpoint.workspace_id AND previous_secret.id=endpoint.previous_secret_version_id
     AND endpoint.previous_secret_valid_until>clock_timestamp()
   WHERE endpoint.endpoint_key_hash=p_endpoint_key_hash;
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.workspace_id',coalesce(prior_workspace,''),true);
  RAISE;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.resolve_public_webhook_endpoint(character) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_public_webhook_endpoint(character) TO {{app_role}};
