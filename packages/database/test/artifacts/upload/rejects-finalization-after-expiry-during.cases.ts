import { expect, it } from 'vitest';

import {
  database,
  workspaceId,
  actor,
  ownerTransaction,
  apiTransaction,
  readCapacity,
} from './fixture.js';

export function registerRejectsFinalizationAfterExpiryDuring(): void {
  it('rejects finalization after expiry and during deletion', async () => {
    const expired = await database.beginUpload({
      actor: actor(),
      byteLength: 41,
      idempotencyKey: 'artifact-upload-expired',
      mediaType: 'application/octet-stream',
      sha256: '4'.repeat(64),
      workspaceId,
    });
    await ownerTransaction(async (client) => {
      await client.query(
        `update app.artifacts set expires_at=clock_timestamp()-interval '1 second'
          where workspace_id=$1 and id=$2`,
        [workspaceId, expired.artifact.id],
      );
    });
    await expect(
      database.finalizeUpload({
        actor: actor(),
        identity: { artifactId: expired.artifact.id, workspaceId },
        expectedMetadata: {
          byteLength: 41,
          mediaType: 'application/octet-stream',
          sha256: '4'.repeat(64),
        },
      }),
    ).rejects.toMatchObject({
      message: 'Artifact upload has expired',
      name: 'ArtifactUploadConflictError',
    });
    await expect(
      database.getForUpload({
        actor: actor(),
        identity: { artifactId: expired.artifact.id, workspaceId },
      }),
    ).resolves.toMatchObject({ status: 'pending' });

    const deleting = await database.beginUpload({
      actor: actor(),
      byteLength: 43,
      idempotencyKey: 'artifact-upload-deleting',
      mediaType: 'application/octet-stream',
      sha256: '5'.repeat(64),
      workspaceId,
    });
    await ownerTransaction(async (client) => {
      await client.query(
        `update app.artifacts set status='deleting',updated_at=clock_timestamp()
          where workspace_id=$1 and id=$2`,
        [workspaceId, deleting.artifact.id],
      );
    });
    await expect(
      database.finalizeUpload({
        actor: actor(),
        identity: { artifactId: deleting.artifact.id, workspaceId },
        expectedMetadata: {
          byteLength: 43,
          mediaType: 'application/octet-stream',
          sha256: '5'.repeat(64),
        },
      }),
    ).rejects.toMatchObject({
      message: 'Artifact upload is not pending',
      name: 'ArtifactUploadConflictError',
    });
    await expect(
      database.getForUpload({
        actor: actor(),
        identity: { artifactId: deleting.artifact.id, workspaceId },
      }),
    ).resolves.toBeNull();
  });

  it('keeps metadata immutable and prevents API capacity counter writes', async () => {
    const created = await database.beginUpload({
      actor: actor(),
      byteLength: 47,
      idempotencyKey: 'artifact-upload-immutable',
      mediaType: 'application/octet-stream',
      sha256: '6'.repeat(64),
      workspaceId,
    });
    const identity = {
      actor: actor(),
      identity: { artifactId: created.artifact.id, workspaceId },
    } as const;
    const capacityBefore = await readCapacity();

    await expect(
      ownerTransaction(async (client) => {
        await client.query(
          `update app.artifacts set media_type='text/plain'
            where workspace_id=$1 and id=$2`,
          [workspaceId, created.artifact.id],
        );
      }),
    ).rejects.toMatchObject({
      code: 'P0002',
      detail: 'artifact_metadata_immutable',
    });
    await expect(database.getMetadata(identity)).resolves.toMatchObject({
      mediaType: 'application/octet-stream',
      byteLength: 47,
      sha256: '6'.repeat(64),
      status: 'pending',
    });

    await expect(
      apiTransaction(async (client) => {
        await client.query(
          `update app.workspace_artifact_capacity
              set charged_bytes=charged_bytes+1
            where workspace_id=$1`,
          [workspaceId],
        );
      }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(readCapacity()).resolves.toEqual(capacityBefore);
  });

  it('releases the reservation exactly once after durable metadata deletion', async () => {
    const created = await database.beginUpload({
      actor: actor(),
      byteLength: 31,
      idempotencyKey: 'release-upload',
      mediaType: 'application/octet-stream',
      sha256: 'd'.repeat(64),
      workspaceId,
    });
    await ownerTransaction(async (client) => {
      await client.query(
        `update app.artifacts
            set status='deleting',updated_at=clock_timestamp()
          where workspace_id=$1 and id=$2`,
        [workspaceId, created.artifact.id],
      );
      await client.query(
        `update app.artifacts
            set status='deleted',deleted_at=clock_timestamp(),updated_at=clock_timestamp()
          where workspace_id=$1 and id=$2`,
        [workspaceId, created.artifact.id],
      );
      await client.query(
        `delete from app.artifacts where workspace_id=$1 and id=$2`,
        [workspaceId, created.artifact.id],
      );
    });
    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: 0,
      chargedCount: 0,
    });
  });
}
