import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import type { ControlLedger } from '../src/control-ledger-coordinator.js';
import { migrateDatabase } from '../src/migrations.js';
import {
  createRetentionDatabase,
  createRetentionEnforcementCoordinator,
} from '../src/retention.js';

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const maintenanceUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';
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
  await migrateDatabase({
    apiRuntimeRole: 'pertexo_api',
    connectionString: migrationUrl,
    dispatcherRole: 'pertexo_dispatcher',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
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
});

describe('workflow-run-input retention dry-run', () => {
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
});
