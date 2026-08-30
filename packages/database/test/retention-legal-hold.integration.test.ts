import { describe, expect, it, vi } from 'vitest';

import {
  type ControlLedger,
  Pool,
  createRetentionEnforcementCoordinator,
  cutoffAt,
  maintenanceUrl,
  owner,
  parseDatabaseConfig,
  randomUUID,
  retention,
  workspaceId,
  zeroHash,
} from './support/retention.integration.support.js';

describe('retention legal hold fencing', () => {
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
