import { expect, it, vi } from 'vitest';
import { ArtifactUploadNotFoundError } from '../../../src/artifacts/uploads/input.js';
import { createArtifactUploadDatabase } from '../../../src/artifacts/uploads/repository.js';
import {
  createRunArtifactRetentionCoordinator,
  maintenanceUrl,
  parseDatabaseConfig,
  randomUUID,
  workspaceId,
  userId,
} from '../retention.support.js';
import { readCapacity, withOwnerTransaction } from './fixture.js';

export function registerFailsLateUploadFinalizationOnce(): void {
  it('fails a late upload finalization once expiry cleanup erased it', async () => {
    const apiUrl = new URL(
      process.env.DATABASE_URL ??
        'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
    );
    apiUrl.pathname = new URL(maintenanceUrl).pathname;
    const uploadDatabase = createArtifactUploadDatabase(
      parseDatabaseConfig({ connectionString: apiUrl.toString(), max: 2 }),
    );
    const releaseVerification = Promise.withResolvers<undefined>();
    let coordinator:
      ReturnType<typeof createRunArtifactRetentionCoordinator> | undefined;
    let finalization: Promise<unknown> | undefined;
    try {
      await withOwnerTransaction(async (client) => {
        await client.query(
          `insert into app.workspace_memberships(workspace_id,user_id,role,status)
           values($1,$2,'owner','active') on conflict do nothing`,
          [workspaceId, userId],
        );
      });
      const actor = {
        actorId: userId,
        kind: 'user' as const,
        requestId: 'retention-finalization-race',
        sessionId: randomUUID(),
        workspaceId,
      };
      const metadata = {
        byteLength: 17,
        mediaType: 'application/octet-stream',
        sha256: 'f'.repeat(64),
      } as const;
      const capacityBefore = await readCapacity();
      const created = await uploadDatabase.beginUpload({
        actor,
        ...metadata,
        idempotencyKey: `retention-finalization-${randomUUID()}`,
        workspaceId,
      });
      const verificationStarted = Promise.withResolvers<undefined>();
      finalization = uploadDatabase
        .finalizeUpload({
          actor,
          expectedMetadata: metadata,
          identity: { artifactId: created.artifact.id, workspaceId },
          verifyUpload: async () => {
            verificationStarted.resolve(undefined);
            await releaseVerification.promise;
          },
        })
        .catch((error: unknown) => error);
      await verificationStarted.promise;
      await withOwnerTransaction(async (client) => {
        await client.query(
          `update app.artifacts set expires_at=clock_timestamp()-interval '1 second'
            where workspace_id=$1 and id=$2`,
          [workspaceId, created.artifact.id],
        );
      });
      const artifacts = {
        delete: vi.fn(() => Promise.resolve()),
        head: vi.fn(() => Promise.resolve(null)),
      };
      coordinator = createRunArtifactRetentionCoordinator(
        parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
        artifacts,
      );
      // Cleanup does not wait for the upload; it erases the expired bytes.
      await expect(coordinator.processNext()).resolves.toMatchObject({
        artifactId: created.artifact.id,
        status: 'completed',
        workspaceId,
      });
      expect(artifacts.delete).toHaveBeenCalledOnce();

      // Finalizing then finds nothing left to make available.
      releaseVerification.resolve(undefined);
      await expect(finalization).resolves.toBeInstanceOf(
        ArtifactUploadNotFoundError,
      );
      await expect(readCapacity()).resolves.toEqual(capacityBefore);
    } finally {
      releaseVerification.resolve(undefined);
      await (finalization ?? Promise.resolve());
      await coordinator?.close();
      await uploadDatabase.close();
    }
  });
}
