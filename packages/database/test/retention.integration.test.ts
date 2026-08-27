import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import type { ControlLedger } from '../src/control-ledger-coordinator.js';
import { migrateDatabase } from '../src/migrations.js';
import {
  createRetentionDatabase,
  createRetentionEnforcementCoordinator,
} from '../src/retention.js';
import { createRunArtifactRetentionCoordinator } from '../src/run-artifact-retention.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const databaseName = `pertexo_test_retention_${randomUUID().replaceAll('-', '')}`;
const withDatabase = (baseUrl: string) => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};
const migrationUrl = withDatabase(migrationBaseUrl);
const maintenanceUrl = withDatabase(
  process.env.DATABASE_MAINTENANCE_URL ??
    'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
);
const workspaceId = randomUUID();
const userId = randomUUID();
const runIds = [
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
] as const;
const cutoffAt = new Date('2026-08-01T00:00:00.000Z');
const zeroHash = '0'.repeat(64);
const retention = createRetentionDatabase(
  parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
  {
    leaseOwner: 'retention-integration',
    leaseSeconds: 60,
    maxPagesPerBatch: 10,
    pageSize: 2,
  },
);
let owner: Pool;

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,
       pertexo_maintenance,pertexo_api,pertexo_worker,pertexo_dispatcher,
       pertexo_lifecycle_command`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase({
    apiRuntimeRole: 'pertexo_api',
    connectionString: migrationUrl,
    dispatcherRole: 'pertexo_dispatcher',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    operatorRole: 'pertexo_operator',
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  });
  owner = new Pool({ connectionString: migrationUrl, max: 1 });
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await owner.query(
      `insert into app.users(id,email,display_name) values($1,$2,'Retention integration')`,
      [userId, `${userId}@example.test`],
    );
    await owner.query(
      `insert into app.workspaces(id,name,slug,created_by)
       values($1,'Retention integration',$2,$3)`,
      [workspaceId, `retention-${workspaceId}`, userId],
    );
    await owner.query(
      'alter table app.workflow_runs no force row level security',
    );
    for (const [index, runId] of runIds.entries()) {
      const expiresAt = new Date(
        index === 3
          ? '2026-08-02T00:00:00.000Z'
          : `2026-07-0${String(index + 1)}T00:00:00.000Z`,
      );
      await owner.query(
        `insert into app.workflow_runs
          (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
           input_ref,input_ref_expires_at,created_at,updated_at)
         values($1,$2,$3,$4,'manual','queued',$5::jsonb,$6,
           $6::timestamptz-interval '30 days',$6::timestamptz-interval '30 days')`,
        [
          runId,
          workspaceId,
          randomUUID(),
          randomUUID(),
          JSON.stringify({ kind: 'inline', schemaVersion: 1, value: index }),
          expiresAt,
        ],
      );
    }
    await owner.query('alter table app.workflow_runs force row level security');
    await owner.query('commit');
  } catch (error: unknown) {
    await owner.query('rollback').catch(() => undefined);
    throw error;
  }
}, 120_000);

afterAll(async () => {
  await retention.close();
  await owner.end();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('retention dry-run and enforcement', () => {
  it('reports bounded resumable inventory without changing tenant data', async () => {
    await retention.checkReadiness({
      expectedMaintenanceRole: 'pertexo_maintenance',
    });
    const batchId = randomUUID();
    await expect(
      retention.startDryRun({
        batchId,
        cutoffAt,
        idempotencyKey: `retention-${batchId}`,
        reason: 'prove due workflow input inventory',
        requestedBy: 'integration-operator',
        workspaceId,
      }),
    ).resolves.toBe(batchId);
    await expect(
      retention.startDryRun({
        batchId,
        cutoffAt,
        idempotencyKey: `retention-${batchId}`,
        reason: 'prove due workflow input inventory',
        requestedBy: 'integration-operator',
        workspaceId,
      }),
    ).resolves.toBe(batchId);

    await expect(retention.processNext()).resolves.toMatchObject({
      batchId,
      eligibleCount: 3,
      examinedCount: 3,
      pageCount: 2,
      status: 'completed',
      workspaceId,
    });

    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        'alter table app.workflow_runs no force row level security',
      );
      const runs = await owner.query<{ input_ref: unknown }>(
        `select input_ref from app.workflow_runs where workspace_id=$1 order by id`,
        [workspaceId],
      );
      expect(runs.rows).toHaveLength(4);
      expect(runs.rows.every(({ input_ref }) => input_ref !== null)).toBe(true);
      const batch = await owner.query(
        `select status,examined_count,eligible_count from app.retention_batches where id=$1`,
        [batchId],
      );
      expect(batch.rows).toEqual([
        { eligible_count: '3', examined_count: '3', status: 'completed' },
      ]);
      const audit = await owner.query<{ action: string }>(
        `select action from app.audit_events where target_id=$1 order by occurred_at,id`,
        [batchId],
      );
      expect(audit.rows).toEqual([
        { action: 'retention.batch_started' },
        { action: 'retention.batch_completed' },
      ]);
      await owner.query(
        'alter table app.workflow_runs force row level security',
      );
      await owner.query('rollback');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
  });

  it('rejects stale fencing and direct serving-role execution without progress', async () => {
    const batchId = randomUUID();
    await retention.startDryRun({
      batchId,
      cutoffAt,
      idempotencyKey: `retention-${batchId}`,
      reason: 'prove stale fencing',
      requestedBy: 'integration-operator',
      workspaceId,
    });
    const claim = (await retention.claimDryRuns())[0];
    if (claim === undefined) throw new Error('Expected retention claim');
    await expect(
      retention.executeDryRunPage({
        ...claim,
        leaseFence: claim.leaseFence + 1,
      }),
    ).resolves.toMatchObject({ stale: true, examinedDelta: 0 });

    const apiUrl = new URL(maintenanceUrl);
    apiUrl.username = 'pertexo_api';
    apiUrl.password = 'pertexo-local-api';
    const api = new Pool({ connectionString: apiUrl.toString(), max: 1 });
    try {
      await expect(
        api.query(
          'select * from app.execute_workflow_run_input_retention_dry_run_page($1,$2,$3,10)',
          [claim.batchId, claim.leaseToken, claim.leaseFence],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        api.query(
          'select * from app.execute_standard_retention_dry_run_page($1,$2,$3,10)',
          [claim.batchId, claim.leaseToken, claim.leaseFence],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        api.query(
          "select * from app.claim_retention_dry_run_batches('api',1,60)",
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        api.query(
          `select * from app.execute_workflow_run_input_retention_page(
            $1,$2,$3,10,0,$4)`,
          [claim.batchId, claim.leaseToken, claim.leaseFence, zeroHash],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await api.end();
    }
  });

  it('clears only due inputs through exact ledger high water and bounded pages', async () => {
    const batchId = randomUUID();
    await retention.startEnforcement({
      batchId,
      cutoffAt,
      idempotencyKey: `retention-${batchId}`,
      reason: 'enforce workflow input retention',
      requestedBy: 'integration-operator',
      workspaceId,
    });
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
    const coordinator = createRetentionEnforcementCoordinator(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
      ledger,
      {
        leaseOwner: 'retention-enforcement-integration',
        leaseSeconds: 60,
        maxPagesPerBatch: 10,
        pageSize: 2,
      },
    );
    try {
      await expect(coordinator.processNext()).resolves.toMatchObject({
        batchId,
        eligibleCount: 3,
        examinedCount: 3,
        pageCount: 2,
        status: 'completed',
      });
    } finally {
      await coordinator.close();
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
      const runs = await owner.query<{
        id: string;
        input_ref: unknown;
        input_ref_expires_at: Date | null;
      }>(
        `select id,input_ref,input_ref_expires_at from app.workflow_runs
         where workspace_id=$1 order by input_ref_expires_at nulls first,id`,
        [workspaceId],
      );
      expect(
        runs.rows.filter(({ input_ref }) => input_ref === null),
      ).toHaveLength(3);
      expect(
        runs.rows.filter(({ input_ref }) => input_ref !== null),
      ).toHaveLength(1);
      expect(
        runs.rows
          .filter(({ input_ref }) => input_ref === null)
          .every(({ input_ref_expires_at }) => input_ref_expires_at === null),
      ).toBe(true);
      await owner.query(
        'alter table app.workflow_runs force row level security',
      );
      await owner.query('rollback');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
  });

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

        await delay(1_100);
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

  it('retains referenced artifacts and deletes unreferenced bytes before metadata', async () => {
    const referencedArtifactId = '00000000-0000-4000-8000-000000000101';
    const expiredArtifactId = '00000000-0000-4000-8000-000000000102';
    const followingArtifactId = '00000000-0000-4000-8000-000000000103';
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        'alter table app.artifacts no force row level security',
      );
      await owner.query(
        'alter table app.workflow_runs no force row level security',
      );
      for (const artifactId of [
        referencedArtifactId,
        expiredArtifactId,
        followingArtifactId,
      ]) {
        await owner.query(
          `insert into app.artifacts
            (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
             status,expires_at,finalized_at)
           values($1,$2,'node-output',$3,'application/json',10,$4,
             'available','2026-07-01T00:00:00Z','2026-06-01T00:00:00Z')`,
          [
            artifactId,
            workspaceId,
            `workspaces/${workspaceId}/artifacts/${artifactId}`,
            'a'.repeat(64),
          ],
        );
      }
      await owner.query(
        `update app.workflow_runs set output_ref=$2::jsonb where id=$1`,
        [
          runIds[3],
          JSON.stringify({
            artifactId: referencedArtifactId,
            kind: 'artifact',
            schemaVersion: 1,
          }),
        ],
      );
      await owner.query('alter table app.artifacts force row level security');
      await owner.query(
        'alter table app.workflow_runs force row level security',
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
    const artifacts = {
      delete: vi.fn(() => Promise.resolve()),
      head: vi
        .fn()
        .mockResolvedValueOnce({ stillPresent: true })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
    };
    const coordinator = createRunArtifactRetentionCoordinator(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
      ledger,
      artifacts,
    );
    try {
      await expect(coordinator.processNext()).resolves.toMatchObject({
        artifactId: referencedArtifactId,
        status: 'referenced',
      });
      await expect(coordinator.processNext()).resolves.toMatchObject({
        artifactId: expiredArtifactId,
        status: 'waiting',
      });
      const writer = new Pool({ connectionString: migrationUrl, max: 1 });
      try {
        await writer.query('begin');
        await writer.query('set local role pertexo_owner');
        await writer.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await writer.query(
          'update app.workflow_runs set output_ref=$2::jsonb where id=$1',
          [
            runIds[3],
            JSON.stringify({
              artifactId: followingArtifactId,
              kind: 'artifact',
              schemaVersion: 1,
            }),
          ],
        );
        let settled = false;
        const following = coordinator.processNext().then((result) => {
          settled = true;
          return result;
        });
        await delay(25);
        expect(settled).toBe(false);
        await writer.query('rollback');
        await expect(following).resolves.toMatchObject({
          artifactId: followingArtifactId,
          status: 'completed',
        });
      } finally {
        await writer.query('rollback').catch(() => undefined);
        await writer.end();
      }
      await owner.query('begin');
      try {
        await owner.query('set local role pertexo_owner');
        await owner.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await owner.query(
          `update app.artifacts set retention_retry_at=clock_timestamp()-interval '1 second'
           where id=$1`,
          [expiredArtifactId],
        );
        await owner.query('commit');
      } catch (error: unknown) {
        await owner.query('rollback').catch(() => undefined);
        throw error;
      }
      await expect(coordinator.processNext()).resolves.toMatchObject({
        artifactId: expiredArtifactId,
        status: 'completed',
      });
      expect(artifacts.delete).toHaveBeenCalledTimes(3);
    } finally {
      await coordinator.close();
    }

    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        'alter table app.artifacts no force row level security',
      );
      const proof = await owner.query(
        `select id,retention_retry_at is not null retry_scheduled
         from app.artifacts where id=any($1::uuid[]) order by id`,
        [[referencedArtifactId, expiredArtifactId, followingArtifactId]],
      );
      expect(proof.rows).toEqual([
        { id: referencedArtifactId, retry_scheduled: true },
      ]);
      await owner.query('alter table app.artifacts force row level security');
      await owner.query('rollback');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
  });

  it('releases unprovable ledger work and durably pauses an active legal hold', async () => {
    const protectedRunId = randomUUID();
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
        `insert into app.workflow_runs
          (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
           input_ref,input_ref_expires_at,created_at,updated_at)
         values($1,$2,$3,$4,'manual','queued',$5::jsonb,$6,
           $6::timestamptz-interval '30 days',$6::timestamptz-interval '30 days')`,
        [
          protectedRunId,
          workspaceId,
          randomUUID(),
          randomUUID(),
          JSON.stringify({ kind: 'inline', schemaVersion: 1, value: 'held' }),
          '2026-07-15T00:00:00.000Z',
        ],
      );
      await owner.query(
        'alter table app.workflow_runs force row level security',
      );
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
    const unavailableBatchId = randomUUID();
    await retention.startEnforcement({
      batchId: unavailableBatchId,
      cutoffAt,
      idempotencyKey: `retention-${unavailableBatchId}`,
      reason: 'prove ledger freshness failure',
      requestedBy: 'integration-operator',
      workspaceId,
    });
    const aheadLedger = {
      append: vi.fn(),
      reconcile: vi.fn(() =>
        Promise.resolve({
          hasMore: false,
          pageEndHash: 'a'.repeat(64),
          pageEndSequence: 1,
          reachedHighWater: true,
          records: [
            {
              actorRef: 'legal-admin',
              commandId: randomUUID(),
              commandType: 'legal_hold_placed' as const,
              legalAuthority: 'case-1',
              occurredAt: '2026-08-20T00:00:00.000Z',
              previousHash: zeroHash,
              reason: 'preserve evidence',
              recordHash: 'a'.repeat(64),
              schemaVersion: 1,
              sequence: 1,
              subjectId: randomUUID(),
              workspaceId,
            },
          ],
        }),
      ),
    } satisfies ControlLedger;
    const unavailableCoordinator = createRetentionEnforcementCoordinator(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
      aheadLedger,
      { leaseOwner: 'retention-ledger-ahead', leaseSeconds: 60 },
    );
    try {
      await expect(unavailableCoordinator.processNext()).resolves.toMatchObject(
        {
          batchId: unavailableBatchId,
          examinedCount: 0,
          status: 'released',
        },
      );
    } finally {
      await unavailableCoordinator.close();
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
      const retained = await owner.query<{ input_ref: unknown }>(
        'select input_ref from app.workflow_runs where id=$1',
        [protectedRunId],
      );
      expect(retained.rows).toEqual([
        {
          input_ref: { kind: 'inline', schemaVersion: 1, value: 'held' },
        },
      ]);
      await owner.query(
        'alter table app.workflow_runs force row level security',
      );
      await owner.query('rollback');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }

    const holdId = randomUUID();
    const holdHash = 'b'.repeat(64);
    const maintenance = new Pool({ connectionString: maintenanceUrl, max: 1 });
    try {
      await maintenance.query(
        `select app.project_workspace_legal_hold(
          $1,1,$2,'legal_hold_placed',$3,$4,$5,
          'legal-admin','case-2','preserve evidence',$6)`,
        [
          workspaceId,
          randomUUID(),
          holdId,
          zeroHash,
          holdHash,
          '2026-08-21T00:00:00.000Z',
        ],
      );
    } finally {
      await maintenance.end();
    }
    const heldLedger = {
      append: vi.fn(),
      reconcile: vi.fn(() =>
        Promise.resolve({
          hasMore: false,
          pageEndHash: holdHash,
          pageEndSequence: 1,
          reachedHighWater: true,
          records: [],
        }),
      ),
    } satisfies ControlLedger;
    const heldCoordinator = createRetentionEnforcementCoordinator(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
      heldLedger,
      { leaseOwner: 'retention-held', leaseSeconds: 60 },
    );
    try {
      await expect(heldCoordinator.processNext()).resolves.toMatchObject({
        batchId: unavailableBatchId,
        examinedCount: 0,
        status: 'paused',
      });
    } finally {
      await heldCoordinator.close();
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
      const proof = await owner.query(
        `select batch.status,batch.pause_reason,run.input_ref
         from app.retention_batches batch cross join app.workflow_runs run
         where batch.id=$1 and run.id=$2`,
        [unavailableBatchId, protectedRunId],
      );
      expect(proof.rows).toEqual([
        {
          input_ref: { kind: 'inline', schemaVersion: 1, value: 'held' },
          pause_reason: 'legal_hold',
          status: 'paused',
        },
      ]);
      await owner.query(
        'alter table app.workflow_runs force row level security',
      );
      await owner.query('rollback');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
  });

  it('schedules bounded enforcement exactly once across concurrency and restart', async () => {
    const scheduledWorkspaceIds = Array.from({ length: 26 }, () =>
      randomUUID(),
    );
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query(
        `update app.retention_schedule_state
         set next_scan_at=clock_timestamp()+interval '1 day'`,
      );
      await owner.query(
        'alter table app.workflow_runs no force row level security',
      );
      for (const scheduledWorkspaceId of scheduledWorkspaceIds) {
        await owner.query("select set_config('app.workspace_id',$1,true)", [
          scheduledWorkspaceId,
        ]);
        await owner.query(
          `insert into app.workspaces(id,name,slug,created_by)
           values($1,'Scheduled retention',$2,$3)`,
          [
            scheduledWorkspaceId,
            `scheduled-retention-${scheduledWorkspaceId}`,
            userId,
          ],
        );
        await owner.query(
          `with observed as (select clock_timestamp() observed_at)
           insert into app.workflow_runs
             (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
              input_ref,input_ref_expires_at,created_at,updated_at)
           select $1,$2,$3,$4,'manual','queued',$5::jsonb,
             observed_at-interval '1 day',observed_at-interval '31 days',
             observed_at-interval '31 days' from observed`,
          [
            randomUUID(),
            scheduledWorkspaceId,
            randomUUID(),
            randomUUID(),
            JSON.stringify({ kind: 'inline', schemaVersion: 1, value: 'due' }),
          ],
        );
      }
      await owner.query(
        'alter table app.workflow_runs force row level security',
      );
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }

    const concurrent = await Promise.all(
      Array.from({ length: 6 }, () => retention.scheduleEnforcement()),
    );
    expect(
      concurrent.reduce((sum, result) => sum + result.scannedCount, 0),
    ).toBe(130);
    expect(
      concurrent.reduce((sum, result) => sum + result.scheduledCount, 0),
    ).toBe(26);
    expect(concurrent.every(({ cutoffAt }) => cutoffAt <= new Date())).toBe(
      true,
    );

    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query(
        `update app.retention_schedule_state
         set next_scan_at=clock_timestamp()-interval '1 second'
         where workspace_id=any($1::uuid[])
           and retention_kind='workflow_run_input'`,
        [scheduledWorkspaceIds],
      );
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
    const restarted = await Promise.all([
      retention.scheduleEnforcement(),
      retention.scheduleEnforcement(),
    ]);
    expect(
      restarted.reduce((sum, result) => sum + result.scannedCount, 0),
    ).toBe(26);
    expect(
      restarted.reduce((sum, result) => sum + result.scheduledCount, 0),
    ).toBe(0);

    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query(
        'alter table app.audit_events no force row level security',
      );
      const proof = await owner.query<{
        audit_count: string;
        batch_count: string;
        future_scan_count: string;
      }>(
        `select
          (select count(*) from app.retention_batches
            where workspace_id=any($1::uuid[]) and not dry_run) batch_count,
          (select count(*) from app.audit_events
            where workspace_id=any($1::uuid[])
              and action='retention.batch_started') audit_count,
          (select count(*) from app.retention_schedule_state
            where workspace_id=any($1::uuid[]) and next_scan_at>clock_timestamp())
            future_scan_count`,
        [scheduledWorkspaceIds],
      );
      expect(proof.rows).toEqual([
        { audit_count: '26', batch_count: '26', future_scan_count: '130' },
      ]);
      await owner.query(
        'alter table app.audit_events force row level security',
      );
      await owner.query('rollback');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }

    const apiUrl = new URL(maintenanceUrl);
    apiUrl.username = 'pertexo_api';
    apiUrl.password = 'pertexo-local-api';
    const api = new Pool({ connectionString: apiUrl.toString(), max: 1 });
    try {
      await expect(
        api.query(
          'select * from app.schedule_workflow_run_input_retention(25)',
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        api.query('select * from app.retention_schedule_state'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await api.end();
    }
  });
});
