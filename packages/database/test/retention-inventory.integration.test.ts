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

describe('retention inventory and input enforcement', () => {
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
});
