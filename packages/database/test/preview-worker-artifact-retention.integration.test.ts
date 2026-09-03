import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';

import {
  artifactStorageKey,
  createPendingPreviewArtifact,
} from '../src/artifacts.js';
import { parseDatabaseConfig } from '../src/config.js';
import type { ControlLedger } from '../src/lifecycle/control-ledger-coordinator.js';
import {
  completePreviewAttempt,
  PREVIEW_STATUS,
} from '../src/preview-execution.js';
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
  withOwnerRole,
  workerPool,
  workspaceId,
} from './support/preview-worker-fixture.js';

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
    const previewDeadline = new Date(Date.now() + 250);
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
    const previewDeadline = new Date(Date.now() + 250);
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
    await ownerPool.query('select pg_sleep(0.3)');
    const ledger: ControlLedger = {
      append: vi.fn(),
      reconcile: vi.fn((request: Parameters<ControlLedger['reconcile']>[0]) =>
        Promise.resolve({
          hasMore: false,
          pageEndHash: request.projectedHash,
          pageEndSequence: request.projectedSequence,
          reachedHighWater: true,
          records: [],
        }),
      ),
    };
    const remove = vi.fn(() => Promise.resolve());
    const coordinator = createPreviewRetentionCoordinator(
      parseDatabaseConfig({
        connectionString: databaseUrl(maintenanceBaseUrl),
        max: 1,
      }),
      ledger,
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
      await expect(processTarget()).resolves.toMatchObject({
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
      await coordinator.close();
    }
  });
});
