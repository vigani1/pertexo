import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';

import {
  artifactStorageKey,
  ArtifactLifecycleConflictError,
  createPendingPreviewArtifact,
} from '../../src/artifacts/store.js';
import { parseDatabaseConfig } from '../../src/config.js';
import {
  completePreviewAttempt,
  PREVIEW_STATUS,
} from '../../src/previews/repository.js';
import { createPreviewRetentionCoordinator } from '../../src/lifecycle/preview-retention.js';
import { databaseSchema } from '../../src/schema.js';
import {
  parseWorkspaceId,
  withTenantScopedClient,
} from '../../src/tenant-access/transactions.js';
import {
  acceptFixture,
  claimFixture,
  databaseUrl,
  maintenanceBaseUrl,
  ownerPool,
  scopedQuery,
  withAdmin,
  withOwnerRole,
  workerPool,
  workspaceId,
} from './worker.fixture.js';

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
    ).rejects.toBeInstanceOf(ArtifactLifecycleConflictError);
    const rolledBack = await scopedQuery<{ count: string }>(
      `select count(*)::text as count from app.artifacts
       where workspace_id=$1 and id=$2`,
      [workspaceId, overRetainedArtifactId],
    );
    expect(rolledBack.rows[0]).toEqual({ count: '0' });
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
  });
  it('deletes one quiesced preview artifact under maintenance without an open transaction', async () => {
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
      { delete: remove, head: () => Promise.resolve(null) },
      { artifactQuiescenceSeconds: 1 },
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
      completion = processTarget();
      await deleteStarted.promise;
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
      expect(remove).toHaveBeenCalledOnce();
      const removed = await scopedQuery<{ artifacts: string; runs: string }>(
        `select
          (select count(*)::text from app.preview_runs where workspace_id=$1 and id=$2) runs,
          (select count(*)::text from app.artifacts where workspace_id=$1 and id=$3) artifacts`,
        [workspaceId, accepted.previewRunId, artifactId],
      );
      expect(removed.rows[0]).toEqual({ artifacts: '0', runs: '0' });
    } finally {
      releaseDelete?.();
      await Promise.allSettled([completion ?? Promise.resolve()]);
      await coordinator.close();
    }
  });
});
