import { expect, it } from 'vitest';

import {
  ArtifactUploadConflictError,
  ArtifactUploadNotFoundError,
} from '../../../src/artifacts/uploads/errors.js';

import {
  database,
  workspaceId,
  actorId,
  actor,
  ownerTransaction,
  readCapacity,
} from './fixture.js';

export function registerFinalizesExactMetadataSupportsNested(): void {
  it('finalizes exact metadata, supports nested actor context and reads only live rows', async () => {
    const created = await database.beginUpload({
      actor: actor(),
      byteLength: 23,
      idempotencyKey: 'finalize-upload',
      mediaType: 'text/plain',
      sha256: 'c'.repeat(64),
      workspaceId,
    });
    const identity = {
      actor: actor(),
      identity: { artifactId: created.artifact.id, workspaceId },
    } as const;
    await expect(database.getForUpload(identity)).resolves.toMatchObject({
      id: created.artifact.id,
      status: 'pending',
    });
    await expect(
      database.finalizeUpload({
        ...identity,
        expectedMetadata: {
          byteLength: 24,
          mediaType: 'text/plain',
          sha256: 'c'.repeat(64),
        },
      }),
    ).rejects.toBeInstanceOf(ArtifactUploadConflictError);

    const finalized = await database.finalizeUpload({
      ...identity,
      expectedMetadata: {
        byteLength: 23,
        mediaType: 'text/plain',
        sha256: 'c'.repeat(64),
      },
    });
    const replay = await database.finalizeUpload({
      ...identity,
      expectedMetadata: {
        byteLength: 23,
        mediaType: 'text/plain',
        sha256: 'c'.repeat(64),
      },
    });
    expect(finalized.status).toBe('available');
    expect(finalized.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 29 * 24 * 60 * 60_000,
    );
    expect(finalized.finalizedAt).toBeInstanceOf(Date);
    expect(replay).toEqual(finalized);
    await expect(database.getMetadata(identity)).resolves.toEqual(finalized);
  });

  it('keeps verified bytes pending when cancellation is observed before finalization', async () => {
    const created = await database.beginUpload({
      actor: actor(),
      byteLength: 31,
      idempotencyKey: 'finalize-upload-post-verification-abort',
      mediaType: 'application/octet-stream',
      sha256: '7'.repeat(64),
      workspaceId,
    });
    const controller = new AbortController();
    const reason = new Error('request canceled after object verification');
    const identity = {
      actor: actor(),
      identity: { artifactId: created.artifact.id, workspaceId },
    } as const;

    await expect(
      database.finalizeUpload({
        ...identity,
        expectedMetadata: {
          byteLength: 31,
          mediaType: 'application/octet-stream',
          sha256: '7'.repeat(64),
        },
        signal: controller.signal,
        verifyUpload: () => {
          controller.abort(reason);
          return Promise.resolve();
        },
      }),
    ).rejects.toBe(reason);
    await expect(database.getForUpload(identity)).resolves.toMatchObject({
      id: created.artifact.id,
      status: 'pending',
    });
    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: 31,
      chargedCount: 1,
    });
  });

  it('rechecks actor authority and lifecycle after object verification', async () => {
    const revoked = await database.beginUpload({
      actor: actor(),
      byteLength: 33,
      idempotencyKey: 'finalize-upload-authority-recheck',
      mediaType: 'application/octet-stream',
      sha256: '8'.repeat(64),
      workspaceId,
    });
    await expect(
      database.finalizeUpload({
        actor: actor(),
        expectedMetadata: {
          byteLength: 33,
          mediaType: 'application/octet-stream',
          sha256: '8'.repeat(64),
        },
        identity: { artifactId: revoked.artifact.id, workspaceId },
        verifyUpload: async () => {
          await ownerTransaction(async (client) => {
            await client.query(
              `update app.workspace_memberships set status='suspended'
                where workspace_id=$1 and user_id=$2`,
              [workspaceId, actorId],
            );
          });
        },
      }),
    ).rejects.toBeInstanceOf(ArtifactUploadNotFoundError);
    await ownerTransaction(async (client) => {
      await client.query(
        `update app.workspace_memberships set status='active'
          where workspace_id=$1 and user_id=$2`,
        [workspaceId, actorId],
      );
    });
    await expect(
      database.getForUpload({
        actor: actor(),
        identity: { artifactId: revoked.artifact.id, workspaceId },
      }),
    ).resolves.toMatchObject({ status: 'pending' });

    const deleting = await database.beginUpload({
      actor: actor(),
      byteLength: 35,
      idempotencyKey: 'finalize-upload-lifecycle-recheck',
      mediaType: 'application/octet-stream',
      sha256: '9'.repeat(64),
      workspaceId,
    });
    await expect(
      database.finalizeUpload({
        actor: actor(),
        expectedMetadata: {
          byteLength: 35,
          mediaType: 'application/octet-stream',
          sha256: '9'.repeat(64),
        },
        identity: { artifactId: deleting.artifact.id, workspaceId },
        verifyUpload: async () => {
          await ownerTransaction(async (client) => {
            await client.query(
              `update app.artifacts set status='deleting',updated_at=clock_timestamp()
                where workspace_id=$1 and id=$2`,
              [workspaceId, deleting.artifact.id],
            );
          });
        },
      }),
    ).rejects.toMatchObject({
      message: 'Artifact upload is not pending',
      name: 'ArtifactUploadConflictError',
    });
  });
}
