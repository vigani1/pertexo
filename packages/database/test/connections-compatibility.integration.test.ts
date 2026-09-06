import { describe, expect, it } from 'vitest';

import {
  Pool,
  api,
  apiBaseUrl,
  canonicalOutboxPayloadChecksum,
  checkDatabaseReadiness,
  createFailureNotificationStore,
  createInput,
  databaseUrl,
  destinations,
  historicalDestinationId,
  historicalDispatchingIntentId,
  historicalIntentId,
  historicalOutboxByIntent,
  historicalRetryIntentId,
  historicalRunId,
  historicalWorkspaceId,
  migrationBaseUrl,
  ownerA,
  ownerB,
  parseDatabaseConfig,
  pgCode,
  priorApplied,
  priorDatabaseName,
  randomUUID,
  upgradeApplied,
  upgradeDatabaseName,
  workerBaseUrl,
  workspaceA,
  workspaceB,
} from './support/connections.integration.support.js';

describe('connection persistence', () => {
  it('idempotently manages immutable failure-notification destinations and workflow policy', async () => {
    const connection = createInput({
      providerKey: 'email',
      authType: 'resend_api_key',
      name: `Email ${randomUUID()}`,
    });
    await api.createConnection(connection);
    const workflowId = randomUUID();
    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    const ownerClient = await owner.connect();
    try {
      await ownerClient.query('begin');
      await ownerClient.query('set local role pertexo_owner');
      await ownerClient.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      await ownerClient.query(
        `insert into app.workflows (id,workspace_id,name,created_by)
         values ($1,$2,'Notification policy',$3)`,
        [workflowId, workspaceA, ownerA],
      );
      await ownerClient.query('commit');
    } finally {
      await ownerClient.query('rollback').catch(() => undefined);
      ownerClient.release();
      await owner.end();
    }

    const destinationId = randomUUID();
    const create = {
      workspaceId: workspaceA,
      actorId: ownerA,
      destinationId,
      config: {
        kind: 'email' as const,
        connectionId: connection.connectionId,
        toEmail: 'Ops@EXAMPLE.TEST',
      },
      idempotencyKey: `destination-create-${destinationId}`,
      requestHash: '1'.repeat(64),
      requestId: `request-${destinationId}`,
    };
    const created = await destinations.create(create);
    expect(created.config).toMatchObject({ toEmail: 'Ops@example.test' });
    const replayed = await destinations.create({
      ...create,
      destinationId: randomUUID(),
    });
    expect(replayed).toEqual(created);
    await expect(
      destinations.create({ ...create, requestHash: '2'.repeat(64) }),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
      name: 'FailureNotificationDestinationError',
    });

    const append = {
      ...create,
      destinationId,
      expectedVersion: 1,
      config: { ...create.config, toEmail: 'alerts@example.test' },
      idempotencyKey: `destination-append-${destinationId}`,
      requestHash: '3'.repeat(64),
    };
    const appended = await destinations.appendVersion(append);
    await expect(destinations.appendVersion(append)).resolves.toEqual(appended);
    expect(appended).toMatchObject({
      currentVersion: 2,
      config: { toEmail: 'alerts@example.test' },
    });

    const setPolicy = {
      workspaceId: workspaceA,
      actorId: ownerA,
      workflowId,
      destinationId,
      idempotencyKey: `policy-set-${workflowId}`,
      requestHash: '4'.repeat(64),
    };
    await destinations.setWorkflowPolicy(setPolicy);
    await destinations.setWorkflowPolicy(setPolicy);
    const status = {
      workspaceId: workspaceA,
      actorId: ownerA,
      destinationId,
      status: 'disabled' as const,
      idempotencyKey: `destination-status-${destinationId}`,
      requestHash: '5'.repeat(64),
    };
    await destinations.setStatus(status);
    await expect(destinations.setStatus(status)).resolves.toMatchObject({
      status: 'disabled',
    });
    await expect(
      destinations.list({ workspaceId: workspaceB, actorId: ownerB }),
    ).resolves.toEqual([]);
    const clearPolicy = {
      workspaceId: workspaceA,
      actorId: ownerA,
      workflowId,
      idempotencyKey: `policy-clear-${workflowId}`,
      requestHash: '6'.repeat(64),
    };
    await destinations.clearWorkflowPolicy(clearPolicy);
    await destinations.clearWorkflowPolicy(clearPolicy);
    const deletion = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
    });
    const deletionClient = await deletion.connect();
    await deletionClient.query('begin');
    await deletionClient.query('set local role pertexo_owner');
    await deletionClient.query(
      "select set_config('app.workspace_id',$1,true)",
      [workspaceA],
    );
    await deletionClient.query('delete from app.workflows where id=$1', [
      workflowId,
    ]);
    await deletionClient.query('commit');
    deletionClient.release();
    await deletion.end();
    await expect(
      destinations.clearWorkflowPolicy(clearPolicy),
    ).resolves.toBeUndefined();
    await expect(
      destinations.clearWorkflowPolicy({
        ...clearPolicy,
        idempotencyKey: `${clearPolicy.idempotencyKey}-new`,
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
      name: 'FailureNotificationDestinationError',
    });

    const audit = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    const auditClient = await audit.connect();
    try {
      await auditClient.query('begin');
      await auditClient.query('set local role pertexo_owner');
      await auditClient.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      const result = await auditClient.query<{ count: string }>(
        `select count(*)::text from app.audit_events
          where target_id in ($1,$2)
            and action in (
              'failure_notification_destination.created',
              'failure_notification_destination.version_appended',
              'failure_notification_destination.disabled',
              'workflow.failure_notification_policy_set',
              'workflow.failure_notification_policy_cleared'
            )`,
        [destinationId, workflowId],
      );
      expect(result.rows[0]?.count).toBe('5');
    } finally {
      await auditClient.query('rollback').catch(() => undefined);
      auditClient.release();
      await audit.end();
    }
  });

  it('upgrades populated exact 0036 notification rows without fabricating destination config', async () => {
    expect(priorApplied).toEqual([
      '0037_failure_notification_destinations.sql',
      '0038_execution_admission.sql',
      '0039_webhook_triggers.sql',
      '0040_schedule_triggers.sql',
      '0041_trigger_hardening.sql',
      '0042_worker_run_admission_lock.sql',
      '0043_workflow_run_input_retention.sql',
      '0044_retention_control_foundation.sql',
      '0045_control_ledger_command_lock.sql',
      '0046_workspace_deletion_control_projection.sql',
      '0047_workspace_lifecycle_command_intents.sql',
      '0048_workspace_lifecycle_command_hardening.sql',
      '0049_workspace_deletion_side_effects.sql',
      '0050_workspace_lifecycle_api_authority.sql',
      '0051_workflow_run_input_retention_dry_run.sql',
      '0052_workflow_run_input_retention_enforcement.sql',
      '0053_preview_retention_enforcement.sql',
      '0054_workflow_run_input_retention_scheduling.sql',
      '0055_standard_retention_classes.sql',
      '0056_workspace_purge_foundation.sql',
      '0057_workspace_tenant_rows_purge.sql',
      '0058_workspace_object_versions_purge.sql',
      '0059_workspace_purge_completion.sql',
      '0060_standard_retention_dry_run.sql',
      '0061_operator_outbox_redispatch.sql',
      '0062_operator_command_ledger.sql',
      '0063_operator_execution_recovery.sql',
      '0064_operator_trigger_reconciliation.sql',
      '0065_operator_run_replay.sql',
      '0066_operator_maintenance_rerun.sql',
      '0067_reconcile_published_migration_repairs.sql',
      '0068_restore_artifact_inventory.sql',
      '0069_regional_write_admission.sql',
      '0070_preview_execution_deadline.sql',
      '0071_oidc_browser_binding.sql',
      '0072_regional_replica_identity.sql',
      '0073_transient_data_retention.sql',
      '0074_retention_schedule_state_rls.sql',
      '0075_workspace_purge_step_release.sql',
      '0076_replay_lineage_retention.sql',
      '0077_replay_read_locks.sql',
      '0078_workflow_lifecycle_revision.sql',
      '0079_artifact_upload_capacity.sql',
      '0080_expired_artifact_upload_retention.sql',
      '0081_schedule_claim_concurrency.sql',
    ]);
    const pool = new Pool({
      connectionString: databaseUrl(apiBaseUrl, priorDatabaseName),
      max: 1,
    });
    try {
      await expect(
        checkDatabaseReadiness(pool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toMatchObject({
        migrationHead: '0081_schedule_claim_concurrency.sql',
      });
      const bindingSurface = await pool.query<{
        node_column: boolean;
        node_constraint: boolean;
        node_worker_update: boolean;
        preview_column: boolean;
        preview_constraint: boolean;
        preview_worker_update: boolean;
      }>(
        `select
           exists (
             select 1 from information_schema.columns
             where table_schema='app' and table_name='node_runs'
               and column_name='provider_dispatch_binding'
               and data_type='character varying' and character_maximum_length=128
           ) node_column,
           exists (
             select 1 from pg_constraint
             where conrelid='app.node_runs'::regclass
               and conname='node_runs_provider_dispatch_binding_format'
           ) node_constraint,
           has_column_privilege(
             'pertexo_worker','app.node_runs','provider_dispatch_binding','UPDATE'
           ) node_worker_update,
           exists (
             select 1 from information_schema.columns
             where table_schema='app' and table_name='preview_attempts'
               and column_name='provider_dispatch_binding'
               and data_type='character varying' and character_maximum_length=128
           ) preview_column,
           exists (
             select 1 from pg_constraint
             where conrelid='app.preview_attempts'::regclass
               and conname='preview_attempts_provider_dispatch_binding_format'
           ) preview_constraint,
           has_column_privilege(
             'pertexo_worker','app.preview_attempts','provider_dispatch_binding','UPDATE'
           ) preview_worker_update`,
      );
      expect(bindingSurface.rows[0]).toEqual({
        node_column: true,
        node_constraint: true,
        node_worker_update: true,
        preview_column: true,
        preview_constraint: true,
        preview_worker_update: true,
      });
      const historicalPool = new Pool({
        connectionString: databaseUrl(migrationBaseUrl, priorDatabaseName),
        max: 1,
      });
      const historicalClient = await historicalPool.connect();
      try {
        await historicalClient.query('begin');
        await historicalClient.query('set local role pertexo_owner');
        await historicalClient.query(
          'alter table app.run_failure_notification_intents no force row level security',
        );
        await historicalClient.query(
          'alter table app.run_failure_notification_audit_facts no force row level security',
        );
        await historicalClient.query(
          "select set_config('app.workspace_id',$1,true)",
          [historicalWorkspaceId],
        );
        const historical = await historicalClient.query<{
          audit_count: string;
          completed_count: string;
          intent_secret: string | null;
          run_secret: string | null;
          dead_letter_count: string;
          ambiguous_count: string;
          unvalidated_fks: string;
        }>(
          `select
             (select connection_secret_version_id::text
                from app.run_failure_notification_intents where id=$1) intent_secret,
              (select failure_notification_connection_secret_version_id::text
                 from app.workflow_runs where id=$2) run_secret,
               (select count(*)::text from app.run_failure_notification_intents
                 where id=any($3::uuid[]) and status='dead_letter'
                   and safe_error_code='delivery.destination_unavailable'
                   and possibly_dispatched=false
                   and completed_at is not null and recovery_at is null
                   and next_delivery_at is null and dispatch_marked_at is null) dead_letter_count,
               (select count(*)::text from app.run_failure_notification_intents
                 where id=$4 and status='outcome_unknown'
                   and safe_error_code='delivery.recovery_ambiguous'
                   and possibly_dispatched=true and completed_at is not null
                   and recovery_at is null and next_delivery_at is null
                   and dispatch_marked_at is null) ambiguous_count,
              (select count(*)::text from app.run_failure_notification_intents
                where id=any($3::uuid[]) and completed_at is not null) completed_count,
              (select count(*)::text from app.run_failure_notification_audit_facts
                where notification_intent_id=any($3::uuid[])
                   and ((notification_intent_id=$4 and fact_type='outcome_unknown'
                         and safe_error_code='delivery.recovery_ambiguous'
                         and possibly_dispatched=true)
                     or (notification_intent_id<>$4 and fact_type='dead_lettered'
                         and safe_error_code='delivery.destination_unavailable'
                         and possibly_dispatched=false))) audit_count,
              (select count(*)::text from pg_constraint
               where conname in (
                 'workflow_runs_failure_notification_destination_version_fk',
                 'run_failure_notification_intents_destination_version_fk'
               ) and not convalidated) unvalidated_fks`,
          [
            historicalIntentId,
            historicalRunId,
            [
              historicalIntentId,
              historicalRetryIntentId,
              historicalDispatchingIntentId,
            ],
            historicalDispatchingIntentId,
          ],
        );
        expect(historical.rows[0]).toEqual({
          audit_count: '3',
          ambiguous_count: '1',
          completed_count: '3',
          dead_letter_count: '2',
          intent_secret: null,
          run_secret: null,
          unvalidated_fks: '2',
        });
        await expect(
          historicalClient.query(
            `insert into app.run_failure_notification_intents (
               id,workspace_id,workflow_run_id,terminal_event_sequence,policy_version,
               destination_id,destination_config_version,side_effect_class,context,
               context_checksum
             ) values ($1,$2,$3,2,1,$4,8,'safe','{}'::jsonb,$5)`,
            [
              randomUUID(),
              historicalWorkspaceId,
              historicalRunId,
              historicalDestinationId,
              'b'.repeat(64),
            ],
          ),
        ).rejects.toSatisfy(pgCode('23503'));
      } finally {
        await historicalClient.query('rollback').catch(() => undefined);
        historicalClient.release();
        await historicalPool.end();
      }
      const historicalStore = createFailureNotificationStore(
        parseDatabaseConfig({
          connectionString: databaseUrl(workerBaseUrl, priorDatabaseName),
          max: 1,
        }),
      );
      try {
        for (const [intentId, outboxEventId] of historicalOutboxByIntent) {
          const payload = {
            schemaVersion: 1 as const,
            workspaceId: historicalWorkspaceId,
            notificationIntentId: intentId,
            outboxEventId,
          };
          await expect(
            historicalStore.claimDelivery({
              workspaceId: historicalWorkspaceId,
              intentId,
              delivery: {
                outboxEventId,
                payloadChecksum: canonicalOutboxPayloadChecksum(payload),
              },
              recoverySeconds: 1,
              maxAttempts: 3,
            }),
          ).resolves.toEqual({ kind: 'terminal' });
        }
      } finally {
        await historicalStore.close();
      }
    } finally {
      await pool.end();
    }
  });

  it('upgrades the supported pre-phase-4 head through all later migrations', async () => {
    expect(upgradeApplied).toEqual([
      '0021_workflow_integration_usage.sql',
      '0022_preview_execution.sql',
      '0023_preview_artifact_ownership.sql',
      '0024_preview_retention_cleanup.sql',
      '0025_preview_cleanup_idempotency.sql',
      '0026_preview_cleanup_terminal_guard.sql',
      '0027_preview_terminal_facts.sql',
      '0028_preview_terminal_fact_corrections.sql',
      '0029_provider_idempotency_key_invariants.sql',
      '0030_coordinator_retry_decisions.sql',
      '0031_due_node_wakeups.sql',
      '0032_for_each_barriers.sql',
      '0033_durable_wait.sql',
      '0034_run_failure_notifications.sql',
      '0035_slack_bot_token_connections.sql',
      '0036_resend_api_key_connections.sql',
      '0037_failure_notification_destinations.sql',
      '0038_execution_admission.sql',
      '0039_webhook_triggers.sql',
      '0040_schedule_triggers.sql',
      '0041_trigger_hardening.sql',
      '0042_worker_run_admission_lock.sql',
      '0043_workflow_run_input_retention.sql',
      '0044_retention_control_foundation.sql',
      '0045_control_ledger_command_lock.sql',
      '0046_workspace_deletion_control_projection.sql',
      '0047_workspace_lifecycle_command_intents.sql',
      '0048_workspace_lifecycle_command_hardening.sql',
      '0049_workspace_deletion_side_effects.sql',
      '0050_workspace_lifecycle_api_authority.sql',
      '0051_workflow_run_input_retention_dry_run.sql',
      '0052_workflow_run_input_retention_enforcement.sql',
      '0053_preview_retention_enforcement.sql',
      '0054_workflow_run_input_retention_scheduling.sql',
      '0055_standard_retention_classes.sql',
      '0056_workspace_purge_foundation.sql',
      '0057_workspace_tenant_rows_purge.sql',
      '0058_workspace_object_versions_purge.sql',
      '0059_workspace_purge_completion.sql',
      '0060_standard_retention_dry_run.sql',
      '0061_operator_outbox_redispatch.sql',
      '0062_operator_command_ledger.sql',
      '0063_operator_execution_recovery.sql',
      '0064_operator_trigger_reconciliation.sql',
      '0065_operator_run_replay.sql',
      '0066_operator_maintenance_rerun.sql',
      '0067_reconcile_published_migration_repairs.sql',
      '0068_restore_artifact_inventory.sql',
      '0069_regional_write_admission.sql',
      '0070_preview_execution_deadline.sql',
      '0071_oidc_browser_binding.sql',
      '0072_regional_replica_identity.sql',
      '0073_transient_data_retention.sql',
      '0074_retention_schedule_state_rls.sql',
      '0075_workspace_purge_step_release.sql',
      '0076_replay_lineage_retention.sql',
      '0077_replay_read_locks.sql',
      '0078_workflow_lifecycle_revision.sql',
      '0079_artifact_upload_capacity.sql',
      '0080_expired_artifact_upload_retention.sql',
      '0081_schedule_claim_concurrency.sql',
    ]);
    const pool = new Pool({
      connectionString: databaseUrl(apiBaseUrl, upgradeDatabaseName),
      max: 1,
    });
    try {
      await expect(
        checkDatabaseReadiness(pool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toMatchObject({
        migrationHead: '0081_schedule_claim_concurrency.sql',
      });
    } finally {
      await pool.end();
    }
  });
});
