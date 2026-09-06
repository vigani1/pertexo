import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import {
  ArtifactQuotaExceededError,
  ArtifactUploadConflictError,
  ArtifactUploadIdempotencyConflictError,
  ArtifactUploadNotFoundError,
  createArtifactUploadDatabase,
} from '../src/execution/artifact-upload.js';
import { migrateDatabase } from '../src/migrations.js';

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';

const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  maintenanceRole: 'pertexo_maintenance',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

const database = createArtifactUploadDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
);
const apiProbePool = new Pool({ connectionString: apiUrl, max: 1 });
const ownerPool = new Pool({ connectionString: migrationUrl, max: 2 });

let workspaceId = randomUUID();
let actorId = randomUUID();
let sessionId = randomUUID();

const actor = () => ({
  actorId,
  kind: 'user' as const,
  requestId: 'artifact-upload-integration',
  sessionId,
  workspaceId,
});

async function ownerTransactionAt<T>(
  scopedWorkspaceId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      scopedWorkspaceId,
    ]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function ownerTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return ownerTransactionAt(workspaceId, work);
}

async function apiTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await apiProbePool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function setCapacity(
  byteLimit: number,
  artifactCountLimit: number,
): Promise<void> {
  await ownerTransaction(async (client) => {
    await client.query(
      `insert into app.workspace_artifact_capacity
         (workspace_id,byte_limit,artifact_count_limit,charged_bytes,charged_count)
       values ($1,$2,$3,0,0)
       on conflict (workspace_id) do update set
         byte_limit=excluded.byte_limit,
         artifact_count_limit=excluded.artifact_count_limit,
         updated_at=clock_timestamp()`,
      [workspaceId, byteLimit, artifactCountLimit],
    );
  });
}

async function readCapacity(): Promise<{
  chargedBytes: number;
  chargedCount: number;
}> {
  return ownerTransaction(async (client) => {
    const result = await client.query<{
      charged_bytes: number | string;
      charged_count: number;
    }>(
      `select charged_bytes,charged_count
         from app.workspace_artifact_capacity where workspace_id=$1`,
      [workspaceId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('artifact capacity row missing');
    return {
      chargedBytes: Number(row.charged_bytes),
      chargedCount: row.charged_count,
    };
  });
}

async function cleanupFixture(): Promise<void> {
  await ownerTransaction(async (client) => {
    await client.query(
      `update app.artifacts set status='deleting',updated_at=clock_timestamp()
         where workspace_id=$1 and status in ('pending','available')`,
      [workspaceId],
    );
    await client.query(
      `update app.artifacts
          set status='deleted',deleted_at=clock_timestamp(),updated_at=clock_timestamp()
        where workspace_id=$1 and status='deleting'`,
      [workspaceId],
    );
    await client.query('delete from app.artifacts where workspace_id=$1', [
      workspaceId,
    ]);
    await client.query(
      'delete from app.idempotency_records where workspace_id=$1',
      [workspaceId],
    );
    await client.query(
      'delete from app.workspace_artifact_capacity where workspace_id=$1',
      [workspaceId],
    );
  });
}

beforeAll(async () => {
  await migrateDatabase(migrationConfig);
});

beforeEach(async () => {
  workspaceId = randomUUID();
  actorId = randomUUID();
  sessionId = randomUUID();
  await ownerTransaction(async (client) => {
    await client.query(
      `insert into app.users(id,email,display_name,status)
       values($1,$2,'Artifact upload actor','active')`,
      [actorId, `${actorId}@artifact-upload.integration.test`],
    );
    await client.query(
      `insert into app.workspaces(id,name,slug,status,created_by)
       values($1,'Artifact upload workspace',$2,'active',$3)`,
      [workspaceId, `artifact-upload-${workspaceId.slice(0, 12)}`, actorId],
    );
    await client.query(
      `insert into app.workspace_memberships(workspace_id,user_id,role,status)
       values($1,$2,'owner','active')`,
      [workspaceId, actorId],
    );
  });
  await setCapacity(1_000, 100);
});

afterEach(async () => {
  await cleanupFixture();
});

afterAll(async () => {
  await database.close();
  await apiProbePool.end();
  await ownerPool.end();
});

describe('artifact upload database authority', () => {
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
    const before = Date.now();
    const created = await database.beginUpload({
      actor: actor(),
      byteLength: 19,
      idempotencyKey: 'artifact-upload-deadline',
      mediaType: 'application/octet-stream',
      sha256: 'e'.repeat(64),
      workspaceId,
    });
    const after = Date.now();
    const deadline = created.artifact.expiresAt.getTime();
    const expectedLowerBound = before + 15 * 60 * 1_000 - 5_000;
    const expectedUpperBound = after + 15 * 60 * 1_000 + 5_000;

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
    await expect(database.getMetadata(identity)).rejects.toBeInstanceOf(
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
    expect(finalized.finalizedAt).toBeInstanceOf(Date);
    expect(replay).toEqual(finalized);
    await expect(database.getMetadata(identity)).resolves.toEqual(finalized);
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
});
