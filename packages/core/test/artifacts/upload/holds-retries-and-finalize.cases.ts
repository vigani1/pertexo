import { createHash, randomUUID } from 'node:crypto';

import { canonicalOutboxPayloadChecksum } from '@pertexo/database/primitives';
import { expect, it, vi } from 'vitest';

import {
  ArtifactUploadConflictError,
  ArtifactUploadIdempotencyConflictError,
} from '../../../src/artifacts/uploads/errors.js';
import {
  actor,
  actorId,
  database,
  ownerTransaction,
  readCapacity,
  workspaceId,
} from './fixture.js';

const FILE: Readonly<{
  byteLength: number;
  mediaType: string;
  sha256: string;
}> = {
  byteLength: 29,
  mediaType: 'text/plain',
  sha256: '9'.repeat(64),
};

const begin = (idempotencyKey: string, file: Partial<typeof FILE> = {}) =>
  database.beginUpload({
    actor: actor(),
    ...FILE,
    ...file,
    idempotencyKey,
    workspaceId,
  });

export function registerHoldsRetriesAndFinalize(): void {
  it('returns the same artifact to a retry after it finished, without charging again', async () => {
    const first = await begin('retried-after-finish');
    const finished = await database.finalizeUpload({
      actor: actor(),
      identity: { artifactId: first.artifact.id, workspaceId },
      expectedMetadata: FILE,
    });
    const charged = await readCapacity();
    await expect(begin('retried-after-finish')).resolves.toEqual({
      artifact: finished,
      replayed: true,
    });
    expect(await readCapacity()).toEqual(charged);
  });

  it.each([
    ['size', { byteLength: 30 }],
    ['media type', { mediaType: 'text/csv' }],
    ['digest', { sha256: 'a'.repeat(64) }],
  ] as const)(
    'refuses a retry with the same key and another %s, charging nothing',
    async (_name, change) => {
      await begin('changed-retry');
      const charged = await readCapacity();
      await expect(begin('changed-retry', change)).rejects.toBeInstanceOf(
        ArtifactUploadIdempotencyConflictError,
      );
      expect(await readCapacity()).toEqual(charged);
    },
  );

  it('keeps one person’s key apart from another’s', async () => {
    const mine = await begin('shared-key');
    const colleague = randomUUID();
    await ownerTransaction(async (client) => {
      await client.query(
        `insert into app.users(id,email,display_name,status)
         values($1,$2,'Artifact colleague','active')`,
        [colleague, `${colleague}@artifact-upload.integration.test`],
      );
      await client.query(
        `insert into app.workspace_memberships(workspace_id,user_id,role,status)
         values($1,$2,'builder','active')`,
        [workspaceId, colleague],
      );
    });
    const theirs = await database.beginUpload({
      actor: { ...actor(), actorId: colleague },
      ...FILE,
      idempotencyKey: 'shared-key',
      workspaceId,
    });
    expect(theirs).toMatchObject({ replayed: false });
    expect(theirs.artifact.id).not.toBe(mine.artifact.id);
  });

  it('stores a receipt an upload retried from before the pass still matches', async () => {
    const key = 'receipt-format';
    await begin(key);
    const stored = await ownerTransaction(async (client) => {
      const { rows } = await client.query<{
        request_hash: string;
        scope: string;
      }>(
        `select request_hash,scope from app.idempotency_records
         where workspace_id=$1 and operation='artifact.upload' and key_hash=$2`,
        [workspaceId, createHash('sha256').update(key).digest('hex')],
      );
      return rows;
    });
    expect(stored).toEqual([
      {
        scope: `${actorId}:artifact-upload`,
        request_hash: canonicalOutboxPayloadChecksum({
          actorId,
          byteLength: FILE.byteLength,
          mediaType: FILE.mediaType,
          operation: 'artifact.upload',
          sha256: FILE.sha256,
          workspaceId,
        }),
      },
    ]);
  });

  it.each([
    ['size', { byteLength: 30 }],
    ['media type', { mediaType: 'text/csv' }],
    ['digest', { sha256: 'a'.repeat(64) }],
  ] as const)(
    'refuses to finalize when the %s does not match and leaves the upload waiting',
    async (_name, change) => {
      const { artifact } = await begin('mismatched-finalize');
      const identity = {
        actor: actor(),
        identity: { artifactId: artifact.id, workspaceId },
      };
      await expect(
        database.finalizeUpload({
          ...identity,
          expectedMetadata: { ...FILE, ...change },
        }),
      ).rejects.toBeInstanceOf(ArtifactUploadConflictError);
      await expect(database.getForUpload(identity)).resolves.toEqual(artifact);
    },
  );

  it('refuses to finalize an upload cleanup started deleting while its bytes were being checked', async () => {
    const { artifact } = await begin('deleted-during-verify');
    const identity = {
      actor: actor(),
      identity: { artifactId: artifact.id, workspaceId },
    };
    await expect(
      database.finalizeUpload({
        ...identity,
        expectedMetadata: FILE,
        verifyUpload: () =>
          ownerTransaction(async (client) => {
            await client.query(
              `update app.artifacts set status='deleting',updated_at=clock_timestamp()
               where workspace_id=$1 and id=$2`,
              [workspaceId, artifact.id],
            );
          }),
      }),
    ).rejects.toBeInstanceOf(ArtifactUploadConflictError);
    await expect(database.getForUpload(identity)).resolves.toBeNull();
    const row = await ownerTransaction(
      async (client) =>
        (
          await client.query<{ status: string; finalized_at: Date | null }>(
            'select status,finalized_at from app.artifacts where workspace_id=$1 and id=$2',
            [workspaceId, artifact.id],
          )
        ).rows[0],
    );
    expect(row).toEqual({ status: 'deleting', finalized_at: null });
  });

  it('refuses to finalize an upload already deleted', async () => {
    const { artifact } = await begin('already-deleted');
    await ownerTransaction(async (client) => {
      await client.query(
        `update app.artifacts set status='deleting',updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2`,
        [workspaceId, artifact.id],
      );
      await client.query(
        `update app.artifacts
           set status='deleted',deleted_at=clock_timestamp(),updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2`,
        [workspaceId, artifact.id],
      );
    });
    // Its bytes are gone or going, so checking them would only give a misleading answer.
    const verifyUpload = vi.fn(() => Promise.resolve());
    await expect(
      database.finalizeUpload({
        actor: actor(),
        identity: { artifactId: artifact.id, workspaceId },
        expectedMetadata: FILE,
        verifyUpload,
      }),
    ).rejects.toMatchObject({
      name: 'ArtifactUploadConflictError',
      message: 'Artifact upload is not pending',
    });
    expect(verifyUpload).not.toHaveBeenCalled();
  });

  it('refuses a finalize retried with other metadata after the upload finished', async () => {
    const { artifact } = await begin('retried-finalize');
    const identity = {
      actor: actor(),
      identity: { artifactId: artifact.id, workspaceId },
    };
    const finished = await database.finalizeUpload({
      ...identity,
      expectedMetadata: FILE,
    });
    await expect(
      database.finalizeUpload({
        ...identity,
        expectedMetadata: { ...FILE, sha256: 'a'.repeat(64) },
      }),
    ).rejects.toBeInstanceOf(ArtifactUploadConflictError);
    await expect(database.getMetadata(identity)).resolves.toEqual(finished);
  });
}
