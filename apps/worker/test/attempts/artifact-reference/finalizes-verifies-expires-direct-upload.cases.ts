import { transportMetrics } from '../../support/transport/metrics.js';
import { createArtifactDatabaseEnvironment } from '../artifacts/database.js';

import { randomUUID } from 'node:crypto';
import {
  ArtifactIntegrityError,
  createArtifactStore,
  parseArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  artifactStorageKey,
  claimDueUnfinalizedArtifact,
  completeArtifactRemoval,
  createPendingArtifact,
  finalizeArtifactUpload,
} from '@pertexo/core/testing';
import {
  artifacts as artifactsTable,
  createWorkspaceDatabase,
} from '@pertexo/database/testing';

import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { observeWorkspaceArtifactCapacity } from '../../../src/runtime/health/artifact-metrics.js';

import { runWithCleanup } from '../../support/infrastructure/test-operation.js';
import { sha256Hex, sha256Base64 } from './fixture.js';

export function registerFinalizesVerifiesExpiresDirectUpload(): void {
  it('finalizes, verifies and expires a direct upload', async () => {
    const databaseEnvironment = createArtifactDatabaseEnvironment();
    const body = Buffer.from('phase-0d finalized artifact');
    const corruptedBody = Buffer.from(body);
    corruptedBody[0] = corruptedBody[0] === 0x50 ? 0x51 : 0x50;
    const metadata = {
      artifactId: randomUUID(),
      byteLength: body.byteLength,
      mediaType: 'application/octet-stream',
      sha256: sha256Hex(body),
      workspaceId: randomUUID(),
    };
    const corruptMetadata = {
      ...metadata,
      artifactId: randomUUID(),
    };
    const expiredMetadata = {
      ...metadata,
      artifactId: randomUUID(),
    };
    const expiresAt = new Date(Date.now() + 300_000);
    let store: ReturnType<typeof createArtifactStore> | undefined;
    let database: ReturnType<typeof createWorkspaceDatabase> | undefined;
    let corruptObjectWritten = false;
    let availableObjectWritten = false;
    let expiredObjectWritten = false;

    await runWithCleanup(
      async () => {
        await databaseEnvironment.initialize();
        store = createArtifactStore(parseArtifactStoreConfig(process.env));
        database = createWorkspaceDatabase(databaseEnvironment.apiConfig);

        await database.withWorkspace(
          metadata.workspaceId,
          async (transaction) => {
            await createPendingArtifact(transaction, {
              ...metadata,
              expiresAt,
              purpose: 'workflow-input',
              storageKey: artifactStorageKey(
                metadata.workspaceId,
                metadata.artifactId,
              ),
            });
            await createPendingArtifact(transaction, {
              ...corruptMetadata,
              expiresAt,
              purpose: 'workflow-input',
              storageKey: artifactStorageKey(
                corruptMetadata.workspaceId,
                corruptMetadata.artifactId,
              ),
            });
            await createPendingArtifact(transaction, {
              ...expiredMetadata,
              expiresAt: new Date(Date.now() - 1_000),
              purpose: 'workflow-input',
              storageKey: artifactStorageKey(
                expiredMetadata.workspaceId,
                expiredMetadata.artifactId,
              ),
            });
          },
        );

        const corruptUpload = await store.beginDirectUpload({
          ...corruptMetadata,
          expiresInSeconds: 300,
        });
        const corruptResponse = await fetch(corruptUpload.url, {
          body: corruptedBody,
          headers: {
            ...corruptUpload.headers,
            // S3Mock intentionally does not validate signatures. Replacing this
            // signed header lets the fixture persist corrupt bytes so finalize's
            // provider-checksum validation is exercised. Real S3 rejects the
            // modified signed request before storing it.
            'x-amz-checksum-sha256': sha256Base64(corruptedBody),
          },
          method: corruptUpload.method,
          signal: AbortSignal.timeout(5_000),
        });
        await corruptResponse.arrayBuffer();
        corruptObjectWritten = corruptResponse.ok;
        expect(corruptResponse.ok).toBe(true);
        await expect(
          store.validateDirectUpload(corruptMetadata),
        ).rejects.toBeInstanceOf(ArtifactIntegrityError);
        await expect(
          database.withWorkspace(metadata.workspaceId, ({ db }) =>
            db
              .select({ status: artifactsTable.status })
              .from(artifactsTable)
              .where(eq(artifactsTable.id, corruptMetadata.artifactId)),
          ),
        ).resolves.toEqual([{ status: 'pending' }]);

        const upload = await store.beginDirectUpload({
          ...metadata,
          expiresInSeconds: 300,
        });
        const uploadResponse = await fetch(upload.url, {
          body,
          headers: upload.headers,
          method: upload.method,
          signal: AbortSignal.timeout(5_000),
        });
        await uploadResponse.arrayBuffer();
        availableObjectWritten = uploadResponse.ok;
        expect(uploadResponse.ok).toBe(true);
        const validated = await store.validateDirectUpload(metadata);
        const finalized = await database.withWorkspace(
          metadata.workspaceId,
          (transaction) =>
            finalizeArtifactUpload(transaction, {
              ...validated,
              storageKey: artifactStorageKey(
                validated.workspaceId,
                validated.artifactId,
              ),
            }),
        );
        expect(finalized.status).toBe('available');

        const expiredUpload = await store.beginDirectUpload({
          ...expiredMetadata,
          expiresInSeconds: 300,
        });
        const expiredUploadResponse = await fetch(expiredUpload.url, {
          body,
          headers: expiredUpload.headers,
          method: expiredUpload.method,
          signal: AbortSignal.timeout(5_000),
        });
        await expiredUploadResponse.arrayBuffer();
        expiredObjectWritten = expiredUploadResponse.ok;
        expect(expiredUploadResponse.ok).toBe(true);
        const claimedForRemoval = await database.withWorkspace(
          expiredMetadata.workspaceId,
          (transaction) =>
            claimDueUnfinalizedArtifact(transaction, {
              artifactId: expiredMetadata.artifactId,
            }),
        );
        expect(claimedForRemoval.id).toBe(expiredMetadata.artifactId);
        await store.delete(expiredMetadata);
        const removed = await database.withWorkspace(
          expiredMetadata.workspaceId,
          (transaction) =>
            completeArtifactRemoval(transaction, {
              artifactId: expiredMetadata.artifactId,
            }),
        );
        expect(removed.status).toBe('deleted');
        await expect(store.head(expiredMetadata)).resolves.toBeNull();

        const metrics = transportMetrics();
        const { observeArtifacts } = metrics;
        await expect(
          observeWorkspaceArtifactCapacity(
            database,
            metrics,
            metadata.workspaceId,
          ),
        ).resolves.toEqual([
          { bytes: body.byteLength, count: 1, status: 'available' },
          { bytes: body.byteLength, count: 1, status: 'deleted' },
          { bytes: 0, count: 0, status: 'deleting' },
          { bytes: body.byteLength, count: 1, status: 'pending' },
        ]);
        expect(observeArtifacts.mock.calls.map(([value]) => value)).toEqual([
          { bytes: body.byteLength, count: 1, status: 'available' },
          { bytes: body.byteLength, count: 1, status: 'deleted' },
          { bytes: 0, count: 0, status: 'deleting' },
          { bytes: body.byteLength, count: 1, status: 'pending' },
        ]);
      },
      async () => {
        const errors: unknown[] = [];
        const attempt = async (operation: () => unknown): Promise<void> => {
          await Promise.resolve()
            .then(operation)
            .catch((error: unknown) => errors.push(error));
        };
        if (availableObjectWritten)
          await attempt(() => store?.delete(metadata));
        if (corruptObjectWritten)
          await attempt(() => store?.delete(corruptMetadata));
        if (expiredObjectWritten)
          await attempt(() => store?.delete(expiredMetadata));
        await attempt(() => store?.close());
        await attempt(() => database?.close());
        await attempt(() => databaseEnvironment.close());
        if (errors.length > 0)
          throw new AggregateError(
            errors,
            'Artifact reference delivery cleanup failed',
          );
      },
      'Artifact reference delivery',
    );
  });
}
