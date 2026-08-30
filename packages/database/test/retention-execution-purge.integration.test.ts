import { describe, expect, it, vi } from 'vitest';

import {
  type ControlLedger,
  Pool,
  createRetentionDatabase,
  createRetentionEnforcementCoordinator,
  cutoffAt,
  maintenanceUrl,
  owner,
  parseDatabaseConfig,
  randomUUID,
  retention,
  userId,
  workspaceId,
  zeroHash,
} from './support/retention.integration.support.js';

describe('retention execution purge stages', () => {
  it('purges execution detail, run summaries, and expired audit facts in bounded stages', async () => {
    const oldRunId = randomUUID();
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    const oldAuditId = randomUUID();
    const oldSecurityFactId = randomUUID();
    const workflowId = randomUUID();
    const workflowVersionId = randomUUID();
    const triggerId = randomUUID();
    const occurrenceId = randomUUID();
    const webhookTriggerId = randomUUID();
    const webhookSecretId = randomUUID();
    const webhookEndpointId = randomUUID();
    const webhookDeliveryId = randomUUID();
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        'alter table app.workflow_runs no force row level security',
      );
      await owner.query(
        'alter table app.node_runs no force row level security',
      );
      await owner.query(
        'alter table app.node_attempts no force row level security',
      );
      await owner.query(
        'alter table app.run_events no force row level security',
      );
      await owner.query(
        'alter table app.audit_events no force row level security',
      );
      await owner.query(
        'alter table app.transport_security_audit_facts no force row level security',
      );
      await owner.query(
        'alter table app.webhook_trigger_secret_versions no force row level security',
      );
      await owner.query(
        'alter table app.webhook_trigger_endpoints no force row level security',
      );
      await owner.query(
        `insert into app.workflow_runs
          (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
           output_ref,error_summary,started_at,completed_at,created_at,updated_at)
         values($1,$2,$3,$4,'manual','succeeded',$5::jsonb,'old failure',
           '2026-04-01T00:00:00Z','2026-04-01T00:01:00Z',
           '2026-04-01T00:00:00Z','2026-04-01T00:01:00Z')`,
        [
          oldRunId,
          workspaceId,
          randomUUID(),
          randomUUID(),
          JSON.stringify({ kind: 'inline', schemaVersion: 1, value: 'detail' }),
        ],
      );
      await owner.query(
        `insert into app.node_runs
          (id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
           status,side_effect_class,input_ref,output_ref,started_at,completed_at)
         values($1,$2,$3,'node-1','node-1','{}','succeeded','safe',
           $4::jsonb,$5::jsonb,'2026-04-01T00:00:10Z','2026-04-01T00:00:20Z')`,
        [
          nodeRunId,
          workspaceId,
          oldRunId,
          JSON.stringify({ kind: 'inline', schemaVersion: 1, value: 'input' }),
          JSON.stringify({ kind: 'inline', schemaVersion: 1, value: 'output' }),
        ],
      );
      await owner.query(
        `insert into app.node_attempts
          (id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
           output_ref,started_at,completed_at)
         values($1,$2,$3,1,'succeeded','safe',$4::jsonb,
           '2026-04-01T00:00:10Z','2026-04-01T00:00:20Z')`,
        [
          attemptId,
          workspaceId,
          nodeRunId,
          JSON.stringify({
            kind: 'inline',
            schemaVersion: 1,
            value: 'attempt',
          }),
        ],
      );
      await owner.query(
        `insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload,created_at)
         values($1,$2,1,'run.succeeded','{}','2026-04-01T00:01:00Z')`,
        [workspaceId, oldRunId],
      );
      await owner.query(
        `insert into app.audit_events
          (id,workspace_id,action,target_type,metadata,occurred_at)
         values($1,$2,'old.audit','workspace','{}','2025-01-01T00:00:00Z')`,
        [oldAuditId, workspaceId],
      );
      await owner.query(
        `insert into app.transport_security_audit_facts
          (id,workspace_id,fact_type,consumer_name,message_id,occurred_at)
         values($1,$2,'inbox_checksum_mismatch','retention-test',$3,
           '2025-01-01T00:00:00Z')`,
        [oldSecurityFactId, workspaceId, randomUUID()],
      );
      await owner.query(
        `insert into app.workflows(id,workspace_id,name,created_by)
         values($1,$2,'Retention trigger summary',$3)`,
        [workflowId, workspaceId, userId],
      );
      await owner.query(
        `insert into app.workflow_versions
          (id,workspace_id,workflow_id,version_number,schema_version,graph_json,
           checksum,published_by,published_at)
         values($1,$2,$3,1,1,'{}',$4,$5,'2026-01-01T00:00:00Z')`,
        [
          workflowVersionId,
          workspaceId,
          workflowId,
          `wf:v1:sha256:${'b'.repeat(64)}`,
          userId,
        ],
      );
      await owner.query(
        `insert into app.workflow_triggers
          (id,workspace_id,workflow_id,workflow_version_id,node_id,kind,status,
           desired_config,config_fingerprint,health_status)
         values($1,$2,$3,$4,'schedule-1','schedule','active','{}',$5,'healthy')`,
        [
          triggerId,
          workspaceId,
          workflowId,
          workflowVersionId,
          `trigger:v1:sha256:${'c'.repeat(64)}`,
        ],
      );
      await owner.query(
        `insert into app.trigger_schedules
          (trigger_id,workspace_id,recurrence_kind,interval_minutes,misfire_policy,
           config_fingerprint,anchor_at,next_fire_at)
         values($1,$2,'interval',60,'skip',$3,
           '2026-01-01T00:00:00Z','2026-09-01T00:00:00Z')`,
        [triggerId, workspaceId, `trigger:v1:sha256:${'c'.repeat(64)}`],
      );
      await owner.query(
        `insert into app.trigger_schedule_occurrences
          (id,workspace_id,trigger_id,scheduled_at,disposition,created_at)
         values($1,$2,$3,'2026-04-01T00:00:00Z','skipped',
           '2026-04-01T00:00:00Z')`,
        [occurrenceId, workspaceId, triggerId],
      );
      await owner.query(
        `insert into app.workflow_triggers
          (id,workspace_id,workflow_id,workflow_version_id,node_id,kind,status,
           desired_config,config_fingerprint,health_status)
         values($1,$2,$3,$4,'webhook-1','webhook','active','{}',$5,'healthy')`,
        [
          webhookTriggerId,
          workspaceId,
          workflowId,
          workflowVersionId,
          `trigger:v1:sha256:${'d'.repeat(64)}`,
        ],
      );
      await owner.query(
        `insert into app.webhook_trigger_secret_versions
          (id,workspace_id,trigger_id,schema_version,kms_key_reference,
           encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
         values($1,$2,$3,1,'kms:test','key','ciphertext','nonce','tag',$4)`,
        [webhookSecretId, workspaceId, webhookTriggerId, userId],
      );
      await owner.query(
        `insert into app.webhook_trigger_endpoints
          (id,workspace_id,trigger_id,endpoint_key_hash,current_secret_version_id)
         values($1,$2,$3,$4,$5)`,
        [
          webhookEndpointId,
          workspaceId,
          webhookTriggerId,
          'e'.repeat(64),
          webhookSecretId,
        ],
      );
      await owner.query(
        `insert into app.webhook_trigger_deliveries
          (id,workspace_id,trigger_id,endpoint_id,workflow_run_id,dedupe_kind,
           received_at,expires_at)
         values($1,$2,$3,$4,$5,'keyed','2026-04-02T00:00:00Z',
           '2026-07-01T00:00:00Z')`,
        [
          webhookDeliveryId,
          workspaceId,
          webhookTriggerId,
          webhookEndpointId,
          oldRunId,
        ],
      );
      await owner.query(
        `insert into app.webhook_trigger_replay_records
          (workspace_id,endpoint_id,dedupe_kind,dedupe_key_hash,
           request_fingerprint,delivery_id,workflow_run_id,expires_at,created_at)
         values($1,$2,'keyed',$3,$4,$5,$6,'2026-07-01T00:00:00Z',
           '2026-06-30T00:00:00Z')`,
        [
          workspaceId,
          webhookEndpointId,
          'f'.repeat(64),
          'a'.repeat(64),
          webhookDeliveryId,
          oldRunId,
        ],
      );
      await owner.query('set constraints all immediate');
      await owner.query(
        'alter table app.workflow_runs force row level security',
      );
      await owner.query('alter table app.node_runs force row level security');
      await owner.query(
        'alter table app.node_attempts force row level security',
      );
      await owner.query('alter table app.run_events force row level security');
      await owner.query(
        'alter table app.audit_events force row level security',
      );
      await owner.query(
        'alter table app.transport_security_audit_facts force row level security',
      );
      await owner.query(
        'alter table app.webhook_trigger_secret_versions force row level security',
      );
      await owner.query(
        'alter table app.webhook_trigger_endpoints force row level security',
      );
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }

    const ledger = {
      append: vi.fn(),
      reconcile: vi.fn(() =>
        Promise.resolve({
          hasMore: false,
          pageEndHash: zeroHash,
          pageEndSequence: 0,
          reachedHighWater: true,
          records: [],
        }),
      ),
    } satisfies ControlLedger;
    const maintenance = new Pool({ connectionString: maintenanceUrl, max: 1 });
    const coordinator = createRetentionEnforcementCoordinator(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
      ledger,
      {
        leaseOwner: 'standard-retention-integration',
        leaseSeconds: 60,
        maxPagesPerBatch: 20,
        pageSize: 1,
      },
    );
    try {
      const pagedRetention = createRetentionDatabase(
        parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
        {
          leaseOwner: 'standard-dry-run-page-one',
          leaseSeconds: 1,
          maxPagesPerBatch: 20,
          pageSize: 1,
        },
      );
      const secondAuditId = randomUUID();
      const deferredAuditId = randomUUID();
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        `insert into app.audit_events
          (id,workspace_id,action,target_type,metadata,occurred_at)
         values($1,$2,'old.audit.second','workspace','{}','2025-01-02T00:00:00Z')`,
        [secondAuditId, workspaceId],
      );
      await owner.query('commit');
      try {
        const pagedBatchId = randomUUID();
        await pagedRetention.startDryRun({
          batchId: pagedBatchId,
          cutoffAt,
          idempotencyKey: `retention-dry-run-${pagedBatchId}`,
          reason: 'prove bounded stage reclaim',
          requestedBy: 'integration-operator',
          retentionKind: 'audit_security',
          workspaceId,
        });
        const firstClaim = (await pagedRetention.claimDryRuns())[0];
        if (firstClaim === undefined)
          throw new Error('Expected first dry-run claim');
        await expect(
          pagedRetention.executeDryRunPage(firstClaim),
        ).resolves.toMatchObject({
          eligibleDelta: 1,
          examinedDelta: 1,
          outcome: 'progressed',
        });

        await owner.query('begin');
        await owner.query('set local role pertexo_owner');
        await owner.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await owner.query(
          `insert into app.audit_events
            (id,workspace_id,action,target_type,metadata,occurred_at)
           values($1,$2,'old.audit.deferred','workspace','{}','2025-01-03T00:00:00Z')`,
          [deferredAuditId, workspaceId],
        );
        await owner.query('commit');

        await owner.query('begin');
        await owner.query('set local role pertexo_owner');
        await owner.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await owner.query(
          "select set_config('app.retention_batch_transition','on',true)",
        );
        await owner.query(
          `update app.retention_batches
              set lease_acquired_at=clock_timestamp()-interval '2 seconds',
                  lease_expires_at=clock_timestamp()-interval '1 second'
            where id=$1`,
          [pagedBatchId],
        );
        await owner.query('commit');
        const reclaimed = (await pagedRetention.claimDryRuns())[0];
        if (reclaimed === undefined)
          throw new Error('Expected reclaimed dry-run claim');
        expect(reclaimed.leaseFence).toBe(firstClaim.leaseFence + 1);
        expect(reclaimed.dryRunCursor).not.toBeNull();
        await expect(
          pagedRetention.executeDryRunPage(firstClaim),
        ).resolves.toMatchObject({ outcome: 'stale', examinedDelta: 0 });
        await expect(
          pagedRetention.executeDryRunPage(reclaimed),
        ).resolves.toMatchObject({
          eligibleDelta: 1,
          examinedDelta: 1,
          outcome: 'progressed',
        });
        await expect(
          pagedRetention.executeDryRunPage(reclaimed),
        ).resolves.toMatchObject({
          eligibleDelta: 1,
          examinedDelta: 1,
          outcome: 'completed',
        });
        await owner.query('begin');
        await owner.query('set local role pertexo_owner');
        await owner.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        const reclaimedProof = await owner.query(
          `select batch.examined_count,batch.eligible_count,
            (select count(*) from app.audit_events where id=$2) deferred_count
           from app.retention_batches batch where batch.id=$1`,
          [pagedBatchId, deferredAuditId],
        );
        expect(reclaimedProof.rows).toEqual([
          {
            deferred_count: '1',
            eligible_count: '3',
            examined_count: '3',
          },
        ]);
        await owner.query('rollback');

        const emptyStageBatchId = randomUUID();
        const emptyWorkspaceId = randomUUID();
        await owner.query('begin');
        await owner.query('set local role pertexo_owner');
        await owner.query(
          `insert into app.workspaces(id,name,slug,created_by)
           values($1,'Empty retention fixture',$2,$3)`,
          [emptyWorkspaceId, `empty-retention-${emptyWorkspaceId}`, userId],
        );
        await owner.query('commit');
        await pagedRetention.startDryRun({
          batchId: emptyStageBatchId,
          cutoffAt,
          idempotencyKey: `retention-dry-run-${emptyStageBatchId}`,
          reason: 'prove empty stage progress',
          requestedBy: 'integration-operator',
          retentionKind: 'trigger_summary',
          workspaceId: emptyWorkspaceId,
        });
        const emptyStageClaim = (await pagedRetention.claimDryRuns())[0];
        if (emptyStageClaim === undefined)
          throw new Error('Expected empty-stage dry-run claim');
        await expect(
          pagedRetention.executeDryRunPage(emptyStageClaim),
        ).resolves.toMatchObject({
          eligibleDelta: 0,
          examinedDelta: 0,
          outcome: 'progressed',
        });
        await pagedRetention.executeDryRunPage(emptyStageClaim);
        await expect(
          pagedRetention.executeDryRunPage(emptyStageClaim),
        ).resolves.toMatchObject({ outcome: 'completed', eligibleDelta: 0 });
      } finally {
        await pagedRetention.close();
      }

      const expectedDryRunCounts = {
        audit_security: 4,
        execution_detail: 1,
        run_summary: 0,
        trigger_summary: 3,
      } as const;
      const expectedExaminedCounts = {
        ...expectedDryRunCounts,
        run_summary: 1,
      } as const;
      for (const retentionKind of [
        'execution_detail',
        'trigger_summary',
        'run_summary',
        'audit_security',
      ] as const) {
        const batchId = randomUUID();
        await retention.startDryRun({
          batchId,
          cutoffAt,
          idempotencyKey: `retention-dry-run-${batchId}`,
          reason: 'prove standard retention inventory',
          requestedBy: 'integration-operator',
          retentionKind,
          workspaceId,
        });
        await expect(retention.processNext()).resolves.toMatchObject({
          batchId,
          eligibleCount: expectedDryRunCounts[retentionKind],
          examinedCount: expectedExaminedCounts[retentionKind],
          retentionKind,
          status: 'completed',
          workspaceId,
        });
      }

      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      const unchanged = await owner.query(
        `select
          (select count(*) from app.node_attempts where id=$1) attempt_count,
          (select count(*) from app.run_events where workflow_run_id=$2) event_count,
          (select count(*) from app.audit_events where id=$3) audit_count,
          (select count(*) from app.audit_events where id=$6) deferred_audit_count,
          (select count(*) from app.transport_security_audit_facts where id=$4)
            security_count,
          (select count(*) from app.trigger_schedule_occurrences where id=$5)
            occurrence_count`,
        [
          attemptId,
          oldRunId,
          oldAuditId,
          oldSecurityFactId,
          occurrenceId,
          deferredAuditId,
        ],
      );
      expect(unchanged.rows).toEqual([
        {
          attempt_count: '1',
          audit_count: '1',
          deferred_audit_count: '1',
          event_count: '1',
          occurrence_count: '1',
          security_count: '1',
        },
      ]);
      await owner.query('rollback');

      for (const retentionKind of [
        'execution_detail',
        'trigger_summary',
        'run_summary',
        'audit_security',
      ] as const) {
        const batchId = randomUUID();
        await maintenance.query(
          `select app.start_retention_batch(
            $1,$2,$3,$4,'2026-08-01T00:00:00Z',false,
            'integration-operator','prove standard retention')`,
          [batchId, workspaceId, `retention-${batchId}`, retentionKind],
        );
        await expect(coordinator.processNext()).resolves.toMatchObject({
          batchId,
          retentionKind,
          status: 'completed',
          workspaceId,
        });
      }
    } finally {
      await coordinator.close();
      await maintenance.end();
    }

    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        'alter table app.workflow_runs no force row level security',
      );
      await owner.query(
        'alter table app.node_runs no force row level security',
      );
      await owner.query(
        'alter table app.node_attempts no force row level security',
      );
      await owner.query(
        'alter table app.run_events no force row level security',
      );
      await owner.query(
        'alter table app.audit_events no force row level security',
      );
      await owner.query(
        'alter table app.transport_security_audit_facts no force row level security',
      );
      const proof = await owner.query(
        `select
          (select count(*) from app.workflow_runs where id=$1) run_count,
          (select count(*) from app.node_runs where id=$2) node_count,
          (select count(*) from app.node_attempts where id=$3) attempt_count,
          (select count(*) from app.run_events where workflow_run_id=$1) event_count,
          (select count(*) from app.audit_events where id=$4) audit_count,
          (select count(*) from app.transport_security_audit_facts where id=$5)
            security_count,
          (select count(*) from app.trigger_schedule_occurrences where id=$6)
            occurrence_count`,
        [
          oldRunId,
          nodeRunId,
          attemptId,
          oldAuditId,
          oldSecurityFactId,
          occurrenceId,
        ],
      );
      expect(proof.rows).toEqual([
        {
          attempt_count: '0',
          audit_count: '0',
          event_count: '0',
          node_count: '0',
          occurrence_count: '0',
          run_count: '0',
          security_count: '0',
        },
      ]);
      await owner.query(
        'alter table app.workflow_runs force row level security',
      );
      await owner.query('alter table app.node_runs force row level security');
      await owner.query(
        'alter table app.node_attempts force row level security',
      );
      await owner.query('alter table app.run_events force row level security');
      await owner.query(
        'alter table app.audit_events force row level security',
      );
      await owner.query(
        'alter table app.transport_security_audit_facts force row level security',
      );
      await owner.query('rollback');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
  });
});
