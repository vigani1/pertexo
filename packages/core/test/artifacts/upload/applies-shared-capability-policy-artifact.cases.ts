import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { ArtifactUploadNotFoundError } from '../../../src/artifacts/uploads/input.js';

import {
  database,
  workspaceId,
  actorId,
  actor,
  ownerTransactionAt,
  ownerTransaction,
  readCapacity,
} from './fixture.js';

export function registerAppliesSharedCapabilityPolicyArtifact(): void {
  it('applies the shared capability policy to artifact reads and uploads', async () => {
    const existing = await database.beginUpload({
      actor: actor(),
      byteLength: 13,
      idempotencyKey: 'artifact-upload-role-policy-seed',
      mediaType: 'application/octet-stream',
      sha256: '2'.repeat(64),
      workspaceId,
    });
    const identity = {
      actor: actor(),
      identity: { artifactId: existing.artifact.id, workspaceId },
    } as const;
    const roleCases = [
      { role: 'owner', canUpload: true },
      { role: 'admin', canUpload: true },
      { role: 'builder', canUpload: true },
      { role: 'operator', canUpload: true },
      { role: 'viewer', canUpload: false },
    ] as const;

    for (const { role, canUpload } of roleCases) {
      await ownerTransaction(async (client) => {
        await client.query(
          `update app.workspace_memberships set role=$3
             where workspace_id=$1 and user_id=$2`,
          [workspaceId, actorId, role],
        );
      });
      await expect(database.getMetadata(identity)).resolves.toMatchObject({
        id: existing.artifact.id,
        status: 'pending',
      });

      const upload = database.beginUpload({
        actor: actor(),
        byteLength: 1,
        idempotencyKey: `artifact-upload-role-policy-${role}`,
        mediaType: 'application/octet-stream',
        sha256: '3'.repeat(64),
        workspaceId,
      });
      if (canUpload) {
        await expect(upload).resolves.toMatchObject({
          artifact: { status: 'pending' },
        });
      } else {
        await expect(upload).rejects.toBeInstanceOf(
          ArtifactUploadNotFoundError,
        );
      }
    }
  });

  it('denies access for inactive membership, actor, and workspace states', async () => {
    const created = await database.beginUpload({
      actor: actor(),
      byteLength: 13,
      idempotencyKey: 'artifact-upload-authorization',
      mediaType: 'application/octet-stream',
      sha256: '2'.repeat(64),
      workspaceId,
    });
    const identity = {
      actor: actor(),
      identity: { artifactId: created.artifact.id, workspaceId },
    } as const;

    await ownerTransaction(async (client) => {
      await client.query(
        `update app.workspace_memberships set status='suspended'
          where workspace_id=$1 and user_id=$2`,
        [workspaceId, actorId],
      );
    });
    await expect(database.getMetadata(identity)).rejects.toBeInstanceOf(
      ArtifactUploadNotFoundError,
    );

    await ownerTransaction(async (client) => {
      await client.query(
        `update app.workspace_memberships set status='active'
          where workspace_id=$1 and user_id=$2`,
        [workspaceId, actorId],
      );
      await client.query(
        `update app.users set status='suspended' where id=$1`,
        [actorId],
      );
    });
    await expect(database.getMetadata(identity)).rejects.toBeInstanceOf(
      ArtifactUploadNotFoundError,
    );

    await ownerTransaction(async (client) => {
      await client.query(`update app.users set status='active' where id=$1`, [
        actorId,
      ]);
      await client.query(
        `update app.workspaces set status='suspended' where id=$1`,
        [workspaceId],
      );
    });
    // A suspended workspace reads but does not change (ADR 013/027).
    await expect(database.getMetadata(identity)).resolves.not.toBeNull();
    await expect(database.getForUpload(identity)).rejects.toBeInstanceOf(
      ArtifactUploadNotFoundError,
    );

    await ownerTransaction(async (client) => {
      await client.query(
        `update app.workspaces set status='active' where id=$1`,
        [workspaceId],
      );
    });
  });

  it('does not read or finalize an artifact from another workspace', async () => {
    const foreignWorkspaceId = randomUUID();
    const foreignArtifactId = randomUUID();

    await ownerTransactionAt(foreignWorkspaceId, async (client) => {
      await client.query(
        `insert into app.workspace_artifact_capacity
           (workspace_id,byte_limit,artifact_count_limit,charged_bytes,charged_count)
         values($1,1000,100,0,0)`,
        [foreignWorkspaceId],
      );
      await client.query(
        `insert into app.artifacts
           (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
            status,expires_at)
         values($1,$2,'user-upload',
           'workspaces/'||$2::uuid::text||'/artifacts/'||$1::uuid::text,
           'application/octet-stream',37,$3,'pending',clock_timestamp()+interval '15 minutes')`,
        [foreignArtifactId, foreignWorkspaceId, '3'.repeat(64)],
      );
    });

    try {
      const foreignIdentity = {
        actor: actor(),
        identity: { artifactId: foreignArtifactId, workspaceId },
      } as const;
      await expect(database.getMetadata(foreignIdentity)).resolves.toBeNull();
      await expect(database.getForUpload(foreignIdentity)).resolves.toBeNull();
      await expect(
        database.finalizeUpload({
          ...foreignIdentity,
          expectedMetadata: {
            byteLength: 37,
            mediaType: 'application/octet-stream',
            sha256: '3'.repeat(64),
          },
        }),
      ).rejects.toBeInstanceOf(ArtifactUploadNotFoundError);
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: 0,
        chargedCount: 0,
      });
    } finally {
      await ownerTransactionAt(foreignWorkspaceId, async (client) => {
        await client.query(
          `update app.artifacts set status='deleting',updated_at=clock_timestamp()
             where workspace_id=$1 and id=$2 and status in ('pending','available')`,
          [foreignWorkspaceId, foreignArtifactId],
        );
        await client.query(
          `update app.artifacts
              set status='deleted',deleted_at=clock_timestamp(),updated_at=clock_timestamp()
            where workspace_id=$1 and id=$2 and status='deleting'`,
          [foreignWorkspaceId, foreignArtifactId],
        );
        await client.query(
          'delete from app.artifacts where workspace_id=$1 and id=$2',
          [foreignWorkspaceId, foreignArtifactId],
        );
        await client.query(
          'delete from app.workspace_artifact_capacity where workspace_id=$1',
          [foreignWorkspaceId],
        );
      });
    }
  });
}
