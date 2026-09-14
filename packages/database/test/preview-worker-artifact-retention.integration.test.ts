import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';

import {
  artifactStorageKey,
  createPendingPreviewArtifact,
} from '../src/execution/artifacts.js';
import { parseDatabaseConfig } from '../src/config.js';
import {
  createControlLedgerCoordinator,
  type AppendControlLedgerRecord,
  type ControlLedger,
  type ControlLedgerRecord,
} from '../src/lifecycle/control-ledger-coordinator.js';
import {
  completePreviewAttempt,
  PREVIEW_STATUS,
} from '../src/execution/preview-execution.js';
import { createPreviewRetentionCoordinator } from '../src/lifecycle/preview-retention.js';
import { databaseSchema } from '../src/schema.js';
import {
  parseWorkspaceId,
  withTenantScopedClient,
} from '../src/tenant-access/workspace.js';
import {
  acceptFixture,
  claimFixture,
  databaseUrl,
  expectPgCode,
  maintenanceBaseUrl,
  ownerPool,
  scopedQuery,
  withAdmin,
  withOwnerRole,
  workerPool,
  workspaceId,
} from './support/preview-worker-fixture.js';

async function waitForApplicationLock(applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await withAdmin(async (admin) => {
      await admin.query("set statement_timeout='1s'");
      return admin.query<{ blocked: boolean }>(
        `select exists (
           select 1 from pg_stat_activity
            where application_name=$1 and wait_event_type='Lock'
         ) blocked`,
        [applicationName],
      );
    });
    if (result.rows[0]?.blocked === true) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`PostgreSQL application ${applicationName} did not block`);
}

describe('preview artifact retention lifecycle', () => {
  it('binds preview artifacts to their owner and enforces inherited retention', async () => {
    const previewDeadline = new Date(Date.now() + 15 * 60_000);
    const accepted = await acceptFixture({ expiresAt: previewDeadline });
    const artifactId = randomUUID();
    await withTenantScopedClient(workerPool, { workspaceId }, (client) =>
      createPendingPreviewArtifact(
        {
          db: drizzle(client, { schema: databaseSchema }),
          workspaceId: parseWorkspaceId(workspaceId),
        },
        {
          artifactId,
          byteLength: 3,
          expiresAt: previewDeadline,
          mediaType: 'application/octet-stream',
          previewRunId: accepted.previewRunId,
          purpose: 'node-output',
          sha256: 'a'.repeat(64),
          storageKey: artifactStorageKey(workspaceId, artifactId),
        },
      ),
    );
    const linked = await scopedQuery<{
      artifact_expires_at: Date;
      owner_id: string;
      owner_kind: string;
      preview_expires_at: Date;
    }>(
      `select artifact.expires_at as artifact_expires_at,
              link.owner_id,link.owner_kind,
              preview.expires_at as preview_expires_at
       from app.artifact_links link
       join app.artifacts artifact
         on artifact.workspace_id=link.workspace_id
        and artifact.id=link.artifact_id
       join app.preview_runs preview
         on preview.workspace_id=link.workspace_id
        and preview.id=link.owner_id
       where link.workspace_id=$1 and link.artifact_id=$2`,
      [workspaceId, artifactId],
    );
    expect(linked.rows[0]).toMatchObject({
      owner_id: accepted.previewRunId,
      owner_kind: 'preview_run',
    });
    expect(linked.rows[0]?.artifact_expires_at.getTime()).toBe(
      linked.rows[0]?.preview_expires_at.getTime(),
    );

    const overRetainedArtifactId = randomUUID();
    await expect(
      withTenantScopedClient(workerPool, { workspaceId }, (client) =>
        createPendingPreviewArtifact(
          {
            db: drizzle(client, { schema: databaseSchema }),
            workspaceId: parseWorkspaceId(workspaceId),
          },
          {
            artifactId: overRetainedArtifactId,
            byteLength: 3,
            expiresAt: new Date(previewDeadline.getTime() + 1),
            mediaType: 'application/octet-stream',
            previewRunId: accepted.previewRunId,
            purpose: 'node-output',
            sha256: 'b'.repeat(64),
            storageKey: artifactStorageKey(workspaceId, overRetainedArtifactId),
          },
        ),
      ),
    ).rejects.toSatisfy(expectPgCode('23514'));
    const rolledBack = await scopedQuery<{ count: string }>(
      `select count(*)::text as count from app.artifacts
       where workspace_id=$1 and id=$2`,
      [workspaceId, overRetainedArtifactId],
    );
    expect(rolledBack.rows[0]).toEqual({ count: '0' });
  });

  it('cannot invoke or stage preview destruction with worker authority', async () => {
    const previewDeadline = new Date(Date.now() + 15 * 60_000);
    const accepted = await acceptFixture({ expiresAt: previewDeadline });
    const artifactId = randomUUID();
    await withTenantScopedClient(workerPool, { workspaceId }, (client) =>
      createPendingPreviewArtifact(
        {
          db: drizzle(client, { schema: databaseSchema }),
          workspaceId: parseWorkspaceId(workspaceId),
        },
        {
          artifactId,
          byteLength: 3,
          expiresAt: previewDeadline,
          mediaType: 'application/octet-stream',
          previewRunId: accepted.previewRunId,
          purpose: 'node-output',
          sha256: '7'.repeat(64),
          storageKey: artifactStorageKey(workspaceId, artifactId),
        },
      ),
    );
    await expect(
      withTenantScopedClient(workerPool, { workspaceId }, (client) =>
        client.query(
          `select app.complete_preview_cleanup($1,$2) as completed`,
          [workspaceId, accepted.previewRunId],
        ),
      ),
    ).rejects.toSatisfy(expectPgCode('42501'));
    await expect(
      withTenantScopedClient(workerPool, { workspaceId }, async (client) => {
        await client.query(
          "select set_config('app.preview_retention_transition','on',true)",
        );
        return client.query(
          `update app.artifacts set status='deleting',updated_at=clock_timestamp()
              where workspace_id=$1 and id=$2`,
          [workspaceId, artifactId],
        );
      }),
    ).rejects.toSatisfy(expectPgCode('42501'));
    const state = await scopedQuery<{ status: string }>(
      `select status from app.artifacts
       where workspace_id=$1 and id=$2`,
      [workspaceId, artifactId],
    );
    expect(state.rows[0]).toEqual({ status: 'pending' });
  });

  it('does not emit ordinary-worker cleanup deliveries for new previews', async () => {
    const previewDeadline = new Date(Date.now() + 15 * 60_000);
    const reusableKeyHash = '9'.repeat(64);
    const accepted = await acceptFixture({
      expiresAt: previewDeadline,
      keyHash: reusableKeyHash,
    });
    const claimedPreview = await claimFixture(
      accepted,
      'worker-preview-cleanup-terminal',
    );
    await completePreviewAttempt(workerPool, {
      delivery: accepted.delivery,
      lease: claimedPreview.lease,
      outcome: {
        safeErrorCode: 'preview.cleanup_fixture',
        status: PREVIEW_STATUS.failed,
      },
      workerId: claimedPreview.workerId,
    });
    const cleanup = await scopedQuery<{
      id: string;
      payload_checksum: string;
    }>(
      `select id,payload_checksum from app.outbox_events
       where workspace_id=$1 and aggregate_id=$2
         and job_name='sweep-expired-previews'`,
      [workspaceId, accepted.previewRunId],
    );
    expect(cleanup.rows).toEqual([]);
  });
  it('deletes one preview artifact under maintenance and exact ledger authority', async () => {
    const previewDeadline = new Date(Date.now() + 1_500);
    const accepted = await acceptFixture({ expiresAt: previewDeadline });
    const claimed = await claimFixture(accepted, 'maintenance-preview-cleanup');
    await completePreviewAttempt(workerPool, {
      delivery: accepted.delivery,
      lease: claimed.lease,
      outcome: {
        safeErrorCode: 'preview.cleanup_fixture',
        status: PREVIEW_STATUS.failed,
      },
      workerId: claimed.workerId,
    });
    const artifactId = randomUUID();
    await withTenantScopedClient(workerPool, { workspaceId }, (client) =>
      createPendingPreviewArtifact(
        {
          db: drizzle(client, { schema: databaseSchema }),
          workspaceId: parseWorkspaceId(workspaceId),
        },
        {
          artifactId,
          byteLength: 3,
          expiresAt: previewDeadline,
          mediaType: 'application/octet-stream',
          previewRunId: accepted.previewRunId,
          purpose: 'node-output',
          sha256: 'e'.repeat(64),
          storageKey: artifactStorageKey(workspaceId, artifactId),
        },
      ),
    );
    await ownerPool.query('select pg_sleep(1.6)');
    const freshnessStarted = Promise.withResolvers<undefined>();
    const releaseFreshness = Promise.withResolvers<undefined>();
    const records: ControlLedgerRecord[] = [];
    let pauseFreshness = false;
    let pausedFreshness = false;
    const appendRecord = vi.fn((input: AppendControlLedgerRecord) => {
      const record = Object.freeze({
        ...input,
        recordHash: (input.commandType === 'legal_hold_placed'
          ? '8'
          : '9'
        ).repeat(64),
        schemaVersion: 1,
      });
      records.push(record);
      return Promise.resolve(record);
    });
    const ledger: ControlLedger = {
      append: appendRecord,
      reconcile: vi.fn(
        async (request: Parameters<ControlLedger['reconcile']>[0]) => {
          if (
            pauseFreshness &&
            request.repairCommandId === undefined &&
            !pausedFreshness
          ) {
            pausedFreshness = true;
            freshnessStarted.resolve(undefined);
            await releaseFreshness.promise;
          }
          const available = records
            .filter((record) => record.sequence > request.projectedSequence)
            .slice(0, request.maxRecords);
          const last = available.at(-1);
          const hasMore = records.some(
            (record) =>
              record.sequence > (last?.sequence ?? request.projectedSequence),
          );
          return {
            hasMore,
            pageEndHash: last?.recordHash ?? request.projectedHash,
            pageEndSequence: last?.sequence ?? request.projectedSequence,
            reachedHighWater: !hasMore,
            records: available,
          };
        },
      ),
    };
    let releaseDelete: (() => void) | undefined;
    const deleteStarted = Promise.withResolvers<undefined>();
    const remove = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseDelete = resolve;
          deleteStarted.resolve(undefined);
        }),
    );
    const coordinatorApplicationName = `preview-retention-${randomUUID()}`;
    const coordinatorUrl = new URL(databaseUrl(maintenanceBaseUrl));
    coordinatorUrl.searchParams.set(
      'application_name',
      coordinatorApplicationName,
    );
    const coordinator = createPreviewRetentionCoordinator(
      parseDatabaseConfig({
        connectionString: coordinatorUrl.toString(),
        max: 2,
      }),
      ledger,
      { delete: remove, head: () => Promise.resolve(null) },
      { artifactQuiescenceSeconds: 1 },
    );
    const holdApplicationName = `preview-command-${randomUUID()}`;
    const holdUrl = new URL(databaseUrl(maintenanceBaseUrl));
    holdUrl.searchParams.set('application_name', holdApplicationName);
    const commandCoordinator = createControlLedgerCoordinator(
      parseDatabaseConfig({ connectionString: holdUrl.toString(), max: 2 }),
      ledger,
      { externalOperationTimeoutMs: 5_000 },
    );
    const processTarget = async () => {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const result = await coordinator.processNext();
        if (
          result.status !== 'idle' &&
          result.previewRunId === accepted.previewRunId
        )
          return result;
      }
      throw new Error('Target preview cleanup was not discovered');
    };
    let completion: ReturnType<typeof processTarget> | undefined;
    let holdResult:
      ReturnType<typeof commandCoordinator.placeLegalHold> | undefined;
    let operationFailure: unknown;
    const cleanupFailures: unknown[] = [];
    const holdId = randomUUID();
    try {
      await expect(processTarget()).resolves.toMatchObject({
        previewRunId: accepted.previewRunId,
        status: 'waiting',
        workspaceId,
      });
      expect(remove).not.toHaveBeenCalled();
      // Quiescence is a database-clock invariant. Backdate only the fixture's
      // observation timestamp instead of making the suite wait in real time.
      await withOwnerRole(async (client) => {
        await client.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await client.query(
          `update app.artifacts
              set updated_at=clock_timestamp() - interval '2 seconds'
            where workspace_id=$1 and id=$2`,
          [workspaceId, artifactId],
        );
      });
      pauseFreshness = true;
      completion = processTarget();
      await freshnessStarted.promise;
      const holdCommandId = randomUUID();
      holdResult = commandCoordinator.placeLegalHold({
        actorRef: 'legal-admin',
        commandId: holdCommandId,
        holdId,
        legalAuthority: 'case-preview-retention-race',
        occurredAt: '2026-09-08T00:00:00.000Z',
        reason: 'serialize preview retention race',
        workspaceId,
      });
      await waitForApplicationLock(holdApplicationName);
      expect(appendRecord).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();

      releaseFreshness.resolve(undefined);
      await deleteStarted.promise;
      expect(appendRecord).not.toHaveBeenCalled();
      const openTransactions = await withAdmin((admin) =>
        admin.query<{ count: string }>(
          `select count(*)::text count from pg_stat_activity
            where datname=current_database()
              and application_name=$1
              and xact_start is not null`,
          [coordinatorApplicationName],
        ),
      );
      expect(openTransactions.rows[0]).toEqual({ count: '0' });
      releaseDelete?.();
      await expect(completion).resolves.toMatchObject({
        artifactId,
        previewRunId: accepted.previewRunId,
        status: 'completed',
        workspaceId,
      });
      await expect(holdResult).resolves.toMatchObject({
        holdId,
        replayed: false,
        workspaceId,
      });
      expect(remove).toHaveBeenCalledOnce();
      expect(appendRecord).toHaveBeenCalledOnce();
      const removed = await scopedQuery<{ artifacts: string; runs: string }>(
        `select
          (select count(*)::text from app.preview_runs where workspace_id=$1 and id=$2) runs,
          (select count(*)::text from app.artifacts where workspace_id=$1 and id=$3) artifacts`,
        [workspaceId, accepted.previewRunId, artifactId],
      );
      expect(removed.rows[0]).toEqual({ artifacts: '0', runs: '0' });
      await commandCoordinator.releaseLegalHold({
        actorRef: 'legal-admin',
        commandId: randomUUID(),
        holdId,
        legalAuthority: 'case-preview-retention-race',
        occurredAt: '2026-09-08T00:00:01.000Z',
        reason: 'release preview retention race hold',
        workspaceId,
      });
    } catch (error: unknown) {
      operationFailure = error;
    } finally {
      releaseFreshness.resolve(undefined);
      releaseDelete?.();
      await Promise.allSettled([
        completion ?? Promise.resolve(),
        holdResult ?? Promise.resolve(),
      ]);
      const closeResults = await Promise.allSettled([
        coordinator.close(),
        commandCoordinator.close(),
      ]);
      for (const result of closeResults)
        if (result.status === 'rejected') cleanupFailures.push(result.reason);
    }
    const failures = [
      ...(operationFailure === undefined ? [] : [operationFailure]),
      ...cleanupFailures,
    ];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        'Preview retention operation and cleanup failed',
      );
  });
});
