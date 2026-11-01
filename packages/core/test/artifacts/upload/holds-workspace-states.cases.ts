import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { ArtifactUploadNotFoundError } from '../../../src/artifacts/uploads/errors.js';
import {
  actor,
  actorId,
  database,
  ownerTransaction,
  readCapacity,
  workspaceId,
} from './fixture.js';

const FILE = {
  byteLength: 31,
  mediaType: 'text/plain',
  sha256: '7'.repeat(64),
} as const;

function setStatus(status: 'active' | 'suspended' | 'pending_deletion') {
  const deleting = status === 'pending_deletion';
  return ownerTransaction((client) =>
    client.query(
      `update app.workspaces set status=$2,
         deletion_requested_at=$3::timestamptz,
         deletion_requested_by=$4::uuid,
         deletion_reason=$5::text,
         purge_after=$6::timestamptz
       where id=$1`,
      [
        workspaceId,
        status,
        deleting ? new Date() : null,
        deleting ? actorId : null,
        deleting ? 'artifact state proof' : null,
        deleting ? new Date(Date.now() + 86_400_000) : null,
      ],
    ),
  );
}

/** One finished file and one upload still waiting for its bytes. */
async function files() {
  const available = await database.finalizeUpload({
    actor: actor(),
    identity: {
      artifactId: (
        await database.beginUpload({
          actor: actor(),
          ...FILE,
          idempotencyKey: 'state-available',
          workspaceId,
        })
      ).artifact.id,
      workspaceId,
    },
    expectedMetadata: FILE,
  });
  const { artifact: pending } = await database.beginUpload({
    actor: actor(),
    ...FILE,
    idempotencyKey: 'state-pending',
    workspaceId,
  });
  return { available, pending };
}

const identityOf = (artifactId: string) => ({
  actor: actor(),
  identity: { artifactId, workspaceId },
});

export function registerHoldsWorkspaceStates(): void {
  it('reads files while suspended and refuses every upload step, charging nothing', async () => {
    const { available, pending } = await files();
    const charged = await readCapacity();
    await setStatus('suspended');
    try {
      await expect(
        database.getMetadata(identityOf(available.id)),
      ).resolves.toEqual(available);
      await expect(
        database.getMetadata(identityOf(pending.id)),
      ).resolves.toEqual(pending);

      await expect(
        database.beginUpload({
          actor: actor(),
          ...FILE,
          idempotencyKey: randomUUID(),
          workspaceId,
        }),
      ).rejects.toBeInstanceOf(ArtifactUploadNotFoundError);
      await expect(
        database.getForUpload(identityOf(pending.id)),
      ).rejects.toBeInstanceOf(ArtifactUploadNotFoundError);
      await expect(
        database.finalizeUpload({
          ...identityOf(pending.id),
          expectedMetadata: FILE,
        }),
      ).rejects.toBeInstanceOf(ArtifactUploadNotFoundError);

      expect(await readCapacity()).toEqual(charged);
      await expect(
        database.getMetadata(identityOf(pending.id)),
      ).resolves.toEqual(pending);
    } finally {
      await setStatus('active');
    }
    // Back to active, the same upload finishes.
    await expect(
      database.finalizeUpload({
        ...identityOf(pending.id),
        expectedMetadata: FILE,
      }),
    ).resolves.toMatchObject({ status: 'available' });
  });

  it('closes files and uploads once a workspace is pending deletion', async () => {
    const { available, pending } = await files();
    await setStatus('pending_deletion');
    try {
      await expect(
        database.getMetadata(identityOf(available.id)),
      ).rejects.toBeInstanceOf(ArtifactUploadNotFoundError);
      await expect(
        database.beginUpload({
          actor: actor(),
          ...FILE,
          idempotencyKey: randomUUID(),
          workspaceId,
        }),
      ).rejects.toBeInstanceOf(ArtifactUploadNotFoundError);
      await expect(
        database.finalizeUpload({
          ...identityOf(pending.id),
          expectedMetadata: FILE,
        }),
      ).rejects.toBeInstanceOf(ArtifactUploadNotFoundError);
    } finally {
      await setStatus('active');
    }
  });
}
