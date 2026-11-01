import { randomUUID } from 'node:crypto';

import type { Role } from '@pertexo/workflow-model';
import { expect, it } from 'vitest';

import { ArtifactUploadNotFoundError } from '../../../src/artifacts/uploads/errors.js';
import {
  actor,
  database,
  ownerTransaction,
  readCapacity,
  workspaceId,
} from './fixture.js';

const FILE = {
  byteLength: 19,
  mediaType: 'application/octet-stream',
  sha256: '6'.repeat(64),
} as const;

/** A person, with a membership in this workspace unless none is asked for. */
async function person(
  membership?: Readonly<{
    role: Role;
    status: 'active' | 'suspended' | 'removed';
  }>,
) {
  const id = randomUUID();
  await ownerTransaction(async (client) => {
    await client.query(
      `insert into app.users(id,email,display_name,status)
       values($1,$2,'Artifact outsider','active')`,
      [id, `${id}@artifact-upload.integration.test`],
    );
    if (membership !== undefined)
      await client.query(
        `insert into app.workspace_memberships(workspace_id,user_id,role,status)
         values($1,$2,$3,$4)`,
        [workspaceId, id, membership.role, membership.status],
      );
  });
  return { ...actor(), actorId: id };
}

function requestsFor(
  outsider: Awaited<ReturnType<typeof person>>,
  artifactId: string,
) {
  const identity = {
    actor: outsider,
    identity: { artifactId, workspaceId },
  };
  return {
    getMetadata: () => database.getMetadata(identity),
    getForUpload: () => database.getForUpload(identity),
    finalizeUpload: () =>
      database.finalizeUpload({ ...identity, expectedMetadata: FILE }),
  };
}

async function reasonFor(attempt: () => Promise<unknown>) {
  const refusal: unknown = await attempt().then(
    () => new Error('Expected a refusal'),
    (error: unknown) => error,
  );
  expect(refusal).toBeInstanceOf(ArtifactUploadNotFoundError);
  return (refusal as Error).message;
}

export function registerHidesFilesFromOutsiders(): void {
  it.each([
    ['someone who never joined', undefined],
    ['a removed member', { role: 'builder', status: 'removed' }],
    ['a suspended member', { role: 'builder', status: 'suspended' }],
  ] as const)(
    'tells %s "not found" whether or not the file exists',
    async (_name, membership) => {
      const { artifact } = await database.beginUpload({
        actor: actor(),
        ...FILE,
        idempotencyKey: 'hidden-from-outsiders',
        workspaceId,
      });
      const before = await readCapacity();
      const outsider = await person(membership);

      const real = requestsFor(outsider, artifact.id);
      const invented = requestsFor(outsider, randomUUID());
      for (const name of [
        'getMetadata',
        'getForUpload',
        'finalizeUpload',
      ] as const)
        expect(await reasonFor(real[name]), name).toBe(
          await reasonFor(invented[name]),
        );
      await expect(
        database.beginUpload({
          actor: outsider,
          ...FILE,
          idempotencyKey: 'outsider-upload',
          workspaceId,
        }),
      ).rejects.toBeInstanceOf(ArtifactUploadNotFoundError);

      await expect(
        database.getForUpload({
          actor: actor(),
          identity: { artifactId: artifact.id, workspaceId },
        }),
      ).resolves.toMatchObject({ status: 'pending' });
      expect(await readCapacity()).toEqual(before);
    },
  );

  it('lets a viewer read a file but neither reach it for upload nor finalize it', async () => {
    const { artifact } = await database.beginUpload({
      actor: actor(),
      ...FILE,
      idempotencyKey: 'viewer-reads-only',
      workspaceId,
    });
    const viewer = await person({ role: 'viewer', status: 'active' });
    const requests = requestsFor(viewer, artifact.id);

    await expect(requests.getMetadata()).resolves.toMatchObject({
      id: artifact.id,
      ...FILE,
    });
    await expect(requests.getForUpload()).rejects.toBeInstanceOf(
      ArtifactUploadNotFoundError,
    );
    await expect(requests.finalizeUpload()).rejects.toBeInstanceOf(
      ArtifactUploadNotFoundError,
    );
    await expect(requests.getMetadata()).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it.each(['admin', 'builder', 'operator'] as const)(
    'lets a %s finalize an upload',
    async (role) => {
      const { artifact } = await database.beginUpload({
        actor: actor(),
        ...FILE,
        idempotencyKey: `finalize-as-${role}`,
        workspaceId,
      });
      const member = await person({ role, status: 'active' });
      await expect(
        requestsFor(member, artifact.id).finalizeUpload(),
      ).resolves.toMatchObject({ id: artifact.id, status: 'available' });
    },
  );

  it('answers a member the same for a file in no workspace of theirs and one that does not exist', async () => {
    const requests = requestsFor(actor(), randomUUID());
    await expect(requests.getMetadata()).resolves.toBeNull();
    await expect(requests.getForUpload()).resolves.toBeNull();
    await expect(requests.finalizeUpload()).rejects.toBeInstanceOf(
      ArtifactUploadNotFoundError,
    );
  });
}
