import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  beforeAllFixture1,
  beforeEachFixture2,
  afterEachFixture3,
  afterAllFixture4,
  database,
  workspaceId,
  actor,
  ownerTransaction,
  setCapacity,
  readCapacity,
  actorId,
  ownerTransactionAt,
  apiTransaction,
} from './upload/fixture.js';
import {
  ArtifactQuotaExceededError,
  ArtifactUploadIdempotencyConflictError,
  ArtifactUploadNotFoundError,
  ArtifactUploadConflictError,
} from '../../src/artifacts/uploads/errors.js';
import { randomUUID, createHash } from 'node:crypto';
import type { Role } from '@pertexo/workflow-model';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/primitives';

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

const FILE2 = {
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
          ...FILE2,
          idempotencyKey: 'state-available',
          workspaceId,
        })
      ).artifact.id,
      workspaceId,
    },
    expectedMetadata: FILE2,
  });
  const { artifact: pending } = await database.beginUpload({
    actor: actor(),
    ...FILE2,
    idempotencyKey: 'state-pending',
    workspaceId,
  });
  return { available, pending };
}

const identityOf = (artifactId: string) => ({
  actor: actor(),
  identity: { artifactId, workspaceId },
});

const FILE3: Readonly<{
  byteLength: number;
  mediaType: string;
  sha256: string;
}> = {
  byteLength: 29,
  mediaType: 'text/plain',
  sha256: '9'.repeat(64),
};

const begin = (idempotencyKey: string, file: Partial<typeof FILE3> = {}) =>
  database.beginUpload({
    actor: actor(),
    ...FILE3,
    ...file,
    idempotencyKey,
    workspaceId,
  });

beforeAll(beforeAllFixture1);
beforeEach(beforeEachFixture2);
afterEach(afterEachFixture3);
afterAll(afterAllFixture4);
describe('artifact upload database authority', () => {
  it.each([
    'application/js\u000bon',
    'application/js\u001fon',
    'application/js\u007fon',
    'application/js\u0100on',
  ])(
    'rejects an HTTP-unsafe media type before reserving capacity %#',
    async (mediaType) => {
      await expect(
        database.beginUpload({
          actor: actor(),
          byteLength: 17,
          idempotencyKey: 'artifact-upload-invalid-media-type',
          mediaType,
          sha256: 'a'.repeat(64),
          workspaceId,
        }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'artifacts_media_type_format',
      });
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: 0,
        chargedCount: 0,
      });
    },
  );

  it('atomically claims idempotency, creates scoped metadata and replays exact retries', async () => {
    const input = {
      actor: actor(),
      byteLength: 17,
      idempotencyKey: 'artifact-upload-replay',
      mediaType: 'application/octet-stream',
      sha256: 'a'.repeat(64),
      workspaceId,
    } as const;
    const first = await database.beginUpload(input);
    const replay = await database.beginUpload(input);

    expect(first.replayed).toBe(false);
    expect(first.artifact).toMatchObject({
      byteLength: 17,
      mediaType: input.mediaType,
      purpose: 'user-upload',
      sha256: input.sha256,
      status: 'pending',
      storageKey: `workspaces/${workspaceId}/artifacts/${first.artifact.id}`,
      workspaceId,
    });
    expect(replay).toEqual({ artifact: first.artifact, replayed: true });
    await expect(
      database.beginUpload({
        ...input,
        byteLength: 18,
      }),
    ).rejects.toBeInstanceOf(ArtifactUploadIdempotencyConflictError);
    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: 17,
      chargedCount: 1,
    });
  });

  it('sets the pending deadline from the database clock at fifteen minutes', async () => {
    const databaseTime = () =>
      ownerTransaction(async (client) => {
        const result = await client.query<{ observed_at: Date }>(
          'select clock_timestamp() observed_at',
        );
        const observed = result.rows[0]?.observed_at;
        if (observed === undefined)
          throw new Error('Database clock did not return a timestamp');
        return observed;
      });
    const before = await databaseTime();
    const created = await database.beginUpload({
      actor: actor(),
      byteLength: 19,
      idempotencyKey: 'artifact-upload-deadline',
      mediaType: 'application/octet-stream',
      sha256: 'e'.repeat(64),
      workspaceId,
    });
    const after = await databaseTime();
    const deadline = created.artifact.expiresAt.getTime();
    const expectedLowerBound = before.getTime() + 15 * 60 * 1_000;
    const expectedUpperBound = after.getTime() + 15 * 60 * 1_000;

    expect(deadline).toBeGreaterThanOrEqual(expectedLowerBound);
    expect(deadline).toBeLessThanOrEqual(expectedUpperBound);
    expect(created.artifact.expiresAt.getTime()).toBeGreaterThan(
      created.artifact.createdAt.getTime(),
    );
  });

  it('serializes concurrent retries for one idempotency key into one charge', async () => {
    const input = {
      actor: actor(),
      byteLength: 29,
      idempotencyKey: 'artifact-upload-concurrent-replay',
      mediaType: 'application/octet-stream',
      sha256: 'f'.repeat(64),
      workspaceId,
    } as const;
    const attempts = await Promise.all([
      database.beginUpload(input),
      database.beginUpload(input),
    ]);

    expect(attempts.map((attempt) => attempt.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(attempts[0].artifact.id).toBe(attempts[1].artifact.id);
    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: 29,
      chargedCount: 1,
    });
  });

  it('serializes quota races and rolls failed reservations back', async () => {
    await setCapacity(4, 1);
    const base = {
      actor: actor(),
      byteLength: 4,
      mediaType: 'application/octet-stream',
      sha256: 'b'.repeat(64),
      workspaceId,
    } as const;
    const attempts = await Promise.allSettled([
      database.beginUpload({ ...base, idempotencyKey: 'quota-race-1' }),
      database.beginUpload({ ...base, idempotencyKey: 'quota-race-2' }),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      attempts.filter(
        (attempt) =>
          attempt.status === 'rejected' &&
          attempt.reason instanceof ArtifactQuotaExceededError,
      ),
    ).toHaveLength(1);
    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: 4,
      chargedCount: 1,
    });
  });

  it('rolls back a failed quota claim without leaving an idempotency record', async () => {
    await setCapacity(0, 0);
    const input = {
      actor: actor(),
      byteLength: 1,
      idempotencyKey: 'artifact-upload-quota-failure',
      mediaType: 'application/octet-stream',
      sha256: '1'.repeat(64),
      workspaceId,
    } as const;

    await expect(database.beginUpload(input)).rejects.toBeInstanceOf(
      ArtifactQuotaExceededError,
    );
    await expect(
      ownerTransaction(async (client) => {
        const result = await client.query<{ count: string }>(
          `select count(*)::text as count
             from app.idempotency_records
            where workspace_id=$1 and operation='artifact.upload'`,
          [workspaceId],
        );
        return Number(result.rows[0]?.count ?? 0);
      }),
    ).resolves.toBe(0);
    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: 0,
      chargedCount: 0,
    });
  });

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

  it('cancels a finalization waiting in its database update and keeps the upload pending', async () => {
    const created = await database.beginUpload({
      actor: actor(),
      byteLength: 37,
      idempotencyKey: 'finalize-upload-blocked-abort',
      mediaType: 'application/octet-stream',
      sha256: '9'.repeat(64),
      workspaceId,
    });
    const identity = {
      actor: actor(),
      identity: { artifactId: created.artifact.id, workspaceId },
    } as const;
    const controller = new AbortController();
    const reason = new Error('request canceled while finalizing');

    await ownerTransaction(async (holder) => {
      await holder.query(
        'select id from app.artifacts where workspace_id=$1 and id=$2 for update',
        [workspaceId, created.artifact.id],
      );
      const finalizing = database.finalizeUpload({
        ...identity,
        expectedMetadata: {
          byteLength: 37,
          mediaType: 'application/octet-stream',
          sha256: '9'.repeat(64),
        },
        signal: controller.signal,
      });
      const canceled = expect(finalizing).rejects.toMatchObject({
        name: 'AbortError',
      });
      await expect
        .poll(
          () =>
            ownerTransaction(
              async (monitor) =>
                (
                  await monitor.query<{ waiting: boolean }>(
                    `select exists(select 1 from pg_locks l
                      join pg_stat_activity a using (pid)
                      where a.datname=current_database() and not l.granted) waiting`,
                  )
                ).rows[0]?.waiting,
            ),
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      controller.abort(reason);
      await canceled;
    });

    await expect(database.getForUpload(identity)).resolves.toMatchObject({
      status: 'pending',
    });
  });

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
          ...FILE2,
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
          expectedMetadata: FILE2,
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
        expectedMetadata: FILE2,
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
          ...FILE2,
          idempotencyKey: randomUUID(),
          workspaceId,
        }),
      ).rejects.toBeInstanceOf(ArtifactUploadNotFoundError);
      await expect(
        database.finalizeUpload({
          ...identityOf(pending.id),
          expectedMetadata: FILE2,
        }),
      ).rejects.toBeInstanceOf(ArtifactUploadNotFoundError);
    } finally {
      await setStatus('active');
    }
  });

  it('returns the same artifact to a retry after it finished, without charging again', async () => {
    const first = await begin('retried-after-finish');
    const finished = await database.finalizeUpload({
      actor: actor(),
      identity: { artifactId: first.artifact.id, workspaceId },
      expectedMetadata: FILE3,
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
      ...FILE3,
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
          byteLength: FILE3.byteLength,
          mediaType: FILE3.mediaType,
          operation: 'artifact.upload',
          sha256: FILE3.sha256,
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
          expectedMetadata: { ...FILE3, ...change },
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
        expectedMetadata: FILE3,
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
        expectedMetadata: FILE3,
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
      expectedMetadata: FILE3,
    });
    await expect(
      database.finalizeUpload({
        ...identity,
        expectedMetadata: { ...FILE3, sha256: 'a'.repeat(64) },
      }),
    ).rejects.toBeInstanceOf(ArtifactUploadConflictError);
    await expect(database.getMetadata(identity)).resolves.toEqual(finished);
  });
});
