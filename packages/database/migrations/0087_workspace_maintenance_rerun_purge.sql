-- Forward repair for PF-04 and WQ-211. The full body is repeated because
-- PostgreSQL has no partial function-body replacement.

CREATE OR REPLACE FUNCTION app.execute_workspace_tenant_rows_page(
  p_job_id uuid,p_lease_token uuid,p_lease_fence bigint,p_page_size integer,
  p_projected_sequence bigint,p_projected_hash char(64)
) RETURNS TABLE(surface varchar,affected_count integer,completed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,app,pg_temp SET row_security=on AS $$
DECLARE
  v_job app.workspace_purge_jobs%ROWTYPE;
  v_step app.workspace_purge_steps%ROWTYPE;
  v_workspace_id uuid;
  v_surface text;
  v_count integer:=0;
  v_table text;
  v_tables constant text[]:=ARRAY[
    'operator_maintenance_rerun_requests',
    'webhook_trigger_replay_records','webhook_trigger_deliveries',
    'run_failure_notification_audit_facts','run_failure_notification_intents',
    'workflow_run_active_admissions','node_attempts','node_runs','run_events',
    'run_checkpoints','artifact_links','preview_attempts',
    'webhook_endpoint_ingress_limits','trigger_schedule_occurrences',
    'trigger_schedules','webhook_trigger_endpoints','webhook_trigger_secret_versions',
    'workflow_triggers','workflow_failure_notification_policies',
    'workflow_runs','workflow_integration_usage','workflow_drafts',
    'connection_events','artifacts','outbox_events','inbox_receipts','idempotency_records',
    'retention_batches','retention_schedule_state','workspace_execution_entitlements',
    'workspace_execution_entitlement_versions','workspace_execution_admission_counters',
    'workspace_lifecycle_operations','workspace_memberships','rls_probe_records'
  ];
  v_preserved constant text[]:=ARRAY[
    'workspaces','workspace_purge_jobs','workspace_control_ledger_projection',
    'workspace_legal_holds','retention_control_audit_facts','audit_events','usage_events',
    'transport_security_audit_facts'
  ];
BEGIN
  IF p_job_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
    OR p_lease_fence<1
    OR p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 500
    OR p_projected_sequence IS NULL OR p_projected_sequence<1
    OR p_projected_hash IS NULL OR p_projected_hash!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid workspace tenant-row purge page' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_job FROM app.workspace_purge_jobs WHERE id=p_job_id FOR UPDATE;
  SELECT * INTO v_step FROM app.workspace_purge_steps
    WHERE job_id=p_job_id AND step_name='tenant_rows' FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'purging' OR v_step.status<>'running'
    OR v_step.lease_token IS DISTINCT FROM p_lease_token
    OR v_step.lease_fence IS DISTINCT FROM p_lease_fence
    OR v_step.lease_expires_at IS NULL
    OR v_step.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'workspace tenant-row purge lease is stale' USING ERRCODE='55000';
  END IF;
  v_workspace_id:=v_job.workspace_id;
  PERFORM 1 FROM app.workspaces workspace WHERE workspace.id=v_workspace_id
    AND workspace.status='purging'
    AND workspace.retention_control_sequence=p_projected_sequence
    AND workspace.retention_control_hash=p_projected_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace tenant-row purge high water changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.workspace_legal_holds hold
      WHERE hold.workspace_id=v_workspace_id AND hold.released_sequence IS NULL) THEN
    RAISE EXCEPTION 'active workspace legal hold blocks tenant-row purge page'
      USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.workspace_purge_delete_token',p_lease_token::text,true);
  SET CONSTRAINTS ALL DEFERRED;

  -- Remove mutable pointers before their immutable rows. These updates are
  -- bounded independently and contain no retained fact material.
  WITH candidates AS (SELECT ctid FROM app.node_runs WHERE workspace_id=v_workspace_id
      AND current_attempt_id IS NOT NULL ORDER BY id LIMIT p_page_size FOR UPDATE)
  UPDATE app.node_runs row
    SET current_attempt_id=NULL,current_attempt_number=NULL FROM candidates
    WHERE row.ctid=candidates.ctid;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count>0 THEN v_surface:='node_run_current_attempts'; END IF;

  -- Audit and metering facts survive only as non-sensitive aggregate evidence.
  IF v_count=0 THEN
    WITH candidates AS (SELECT ctid FROM app.audit_events WHERE workspace_id=v_workspace_id
        AND (actor_user_id IS NOT NULL OR request_id IS NOT NULL OR trace_id IS NOT NULL OR metadata<>'{}'::jsonb
          OR target_id IS DISTINCT FROM v_workspace_id) ORDER BY occurred_at,id LIMIT p_page_size FOR UPDATE)
    UPDATE app.audit_events row SET actor_user_id=NULL,request_id=NULL,trace_id=NULL,metadata='{}'::jsonb,
      target_id=v_workspace_id FROM candidates WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='audit_events_minimized'; END IF;
  END IF;
  IF v_count=0 THEN
    WITH candidates AS (SELECT ctid FROM app.usage_events WHERE workspace_id=v_workspace_id
        AND (metadata<>'{}'::jsonb OR resource_id<>v_workspace_id
          OR resource_type<>'workspace-tombstone' OR idempotency_key<>id::text)
        ORDER BY occurred_at,id LIMIT p_page_size FOR UPDATE)
    UPDATE app.usage_events row SET metadata='{}'::jsonb,resource_id=v_workspace_id,
      resource_type='workspace-tombstone',idempotency_key=id::text
      FROM candidates WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='usage_events_minimized'; END IF;
  END IF;
  IF v_count=0 THEN
    WITH candidates AS (SELECT ctid FROM app.transport_security_audit_facts
        WHERE workspace_id=v_workspace_id
          AND (consumer_name<>'purged' OR message_id<>id)
        ORDER BY occurred_at,id LIMIT p_page_size FOR UPDATE)
    UPDATE app.transport_security_audit_facts row SET consumer_name='purged',message_id=id
      FROM candidates WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='transport_security_audit_facts_minimized'; END IF;
  END IF;

  -- Creation idempotency uses resource_id rather than workspace_id.
  IF v_count=0 THEN
    WITH candidates AS (SELECT ctid FROM app.workspace_creation_idempotency_records
        WHERE resource_id=v_workspace_id ORDER BY id LIMIT p_page_size FOR UPDATE)
    DELETE FROM app.workspace_creation_idempotency_records row USING candidates
      WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='workspace_creation_idempotency_records'; END IF;
  END IF;

  IF v_count=0 THEN
    FOREACH v_table IN ARRAY v_tables LOOP
      IF to_regclass('app.'||v_table) IS NULL THEN CONTINUE; END IF;
      EXECUTE format('WITH candidates AS (SELECT ctid FROM app.%I WHERE workspace_id=$1 ORDER BY ctid LIMIT $2 FOR UPDATE) DELETE FROM app.%I row USING candidates WHERE row.ctid=candidates.ctid',v_table,v_table)
        USING v_workspace_id,p_page_size;
      GET DIAGNOSTICS v_count=ROW_COUNT;
      IF v_count>0 THEN v_surface:=v_table; EXIT; END IF;
    END LOOP;
  END IF;

  -- Self-referencing previews are removed from leaves toward roots.
  IF v_count=0 THEN
    WITH candidates AS (SELECT preview.ctid FROM app.preview_runs preview
        WHERE preview.workspace_id=v_workspace_id AND NOT EXISTS (
          SELECT 1 FROM app.preview_runs child
          WHERE child.workspace_id=v_workspace_id AND child.prior_preview_run_id=preview.id)
        ORDER BY preview.id LIMIT p_page_size FOR UPDATE)
    DELETE FROM app.preview_runs row USING candidates WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='preview_runs'; END IF;
  END IF;

  -- Workflow publication FKs are immediate in both directions. Clear the
  -- mutable parent pointer before deleting version children on later pages.
  IF v_count=0 THEN
    WITH candidates AS (SELECT ctid FROM app.workflows
        WHERE workspace_id=v_workspace_id AND published_version_id IS NOT NULL
        ORDER BY id LIMIT p_page_size FOR UPDATE)
    UPDATE app.workflows row SET published_version_id=NULL
      FROM candidates WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='workflow_published_versions'; END IF;
  END IF;

  -- Deferred current-version relationships are deleted as bounded units after
  -- all external references and non-current versions have gone.
  IF v_count=0 THEN
    WITH candidates AS (SELECT version.ctid FROM app.workflow_versions version
        JOIN app.workflows workflow ON workflow.id=version.workflow_id
        WHERE version.workspace_id=v_workspace_id
          AND version.id IS DISTINCT FROM workflow.published_version_id
        ORDER BY version.id LIMIT p_page_size FOR UPDATE)
    DELETE FROM app.workflow_versions row USING candidates WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='workflow_versions'; END IF;
  END IF;
  IF v_count=0 THEN
    WITH candidates AS (SELECT workflow.ctid FROM app.workflows workflow
        WHERE workflow.workspace_id=v_workspace_id
          AND workflow.published_version_id IS NULL
        ORDER BY workflow.id LIMIT p_page_size FOR UPDATE)
    DELETE FROM app.workflows row USING candidates WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='unpublished_workflows'; END IF;
  END IF;
  IF v_count=0 THEN
    WITH candidates AS (SELECT version.ctid FROM app.connection_secret_versions version
        JOIN app.connections connection ON connection.id=version.connection_id
        WHERE version.workspace_id=v_workspace_id
          AND version.id<>connection.current_secret_version_id
        ORDER BY version.id LIMIT p_page_size FOR UPDATE)
    DELETE FROM app.connection_secret_versions row USING candidates WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='connection_secret_versions'; END IF;
  END IF;
  IF v_count=0 THEN
    WITH candidates AS (SELECT connection.id,connection.current_secret_version_id
        FROM app.connections connection WHERE connection.workspace_id=v_workspace_id
        ORDER BY connection.id LIMIT greatest(1,p_page_size/2) FOR UPDATE),
      deleted_versions AS (
        DELETE FROM app.connection_secret_versions version USING candidates
        WHERE version.id=candidates.current_secret_version_id
        RETURNING version.connection_id
      )
    DELETE FROM app.connections connection USING candidates
      WHERE connection.id=candidates.id
        AND EXISTS (SELECT 1 FROM deleted_versions
          WHERE deleted_versions.connection_id=connection.id);
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='connections_with_current_secrets'; v_count:=v_count*2; END IF;
  END IF;
  IF v_count=0 THEN
    WITH candidates AS (SELECT version.ctid
        FROM app.failure_notification_destination_versions version
        JOIN app.failure_notification_destinations destination
          ON destination.id=version.destination_id
        WHERE version.workspace_id=v_workspace_id
          AND version.version<>destination.current_config_version
        ORDER BY version.destination_id,version.version LIMIT p_page_size FOR UPDATE)
    DELETE FROM app.failure_notification_destination_versions row USING candidates
      WHERE row.ctid=candidates.ctid;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='failure_notification_destination_versions'; END IF;
  END IF;
  IF v_count=0 THEN
    WITH candidates AS (SELECT destination.id,destination.current_config_version
        FROM app.failure_notification_destinations destination
        WHERE destination.workspace_id=v_workspace_id
        ORDER BY destination.id LIMIT greatest(1,p_page_size/2) FOR UPDATE),
      deleted_versions AS (
        DELETE FROM app.failure_notification_destination_versions version
        USING candidates WHERE version.destination_id=candidates.id
          AND version.version=candidates.current_config_version
        RETURNING version.destination_id
      )
    DELETE FROM app.failure_notification_destinations destination
      USING candidates WHERE destination.id=candidates.id
        AND EXISTS (SELECT 1 FROM deleted_versions
          WHERE deleted_versions.destination_id=destination.id);
    GET DIAGNOSTICS v_count=ROW_COUNT;
    IF v_count>0 THEN v_surface:='destinations_with_current_versions'; v_count:=v_count*2; END IF;
  END IF;

  PERFORM set_config('app.workspace_purge_transition','on',true);
  IF v_count>0 THEN
    UPDATE app.workspace_purge_steps SET status='pending',lease_owner=NULL,lease_token=NULL,
      lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE job_id=p_job_id AND step_name='tenant_rows';
    RETURN QUERY SELECT v_surface::varchar,v_count,false;
    RETURN;
  END IF;

  -- Fail closed when a new persisted tenant surface was not explicitly added
  -- to the dependency order above. Preserved facts are separately minimized.
  FOR v_table IN
    SELECT table_record.table_name FROM information_schema.columns table_record
    WHERE table_record.table_schema='app' AND table_record.column_name='workspace_id'
      AND table_record.table_name<>ALL(v_preserved)
    GROUP BY table_record.table_name ORDER BY table_record.table_name
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM app.%I WHERE workspace_id=$1)',v_table)
      INTO completed USING v_workspace_id;
    IF completed THEN
      RAISE EXCEPTION 'workspace tenant-row purge has residual rows in %',v_table
        USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM app.workspace_creation_idempotency_records
      WHERE resource_id=v_workspace_id) THEN
    RAISE EXCEPTION 'workspace tenant-row purge has residual workspace creation rows'
      USING ERRCODE='55000';
  END IF;
  UPDATE app.workspace_purge_steps SET status='completed',lease_owner=NULL,lease_token=NULL,
    lease_acquired_at=NULL,lease_expires_at=NULL,updated_at=clock_timestamp(),
    completed_at=clock_timestamp() WHERE job_id=p_job_id AND step_name='tenant_rows';
  RETURN QUERY SELECT 'tenant_rows'::varchar,0,true;
END $$;

REVOKE ALL ON FUNCTION app.workspace_purge_immutable_delete_is_armed(uuid),
  app.find_due_workspace_purge_step(),
  app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,char)
  FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}},
    {{lifecycle_command_role}};
GRANT EXECUTE ON FUNCTION app.find_due_workspace_purge_step(),
  app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,char)
  TO {{maintenance_role}};
