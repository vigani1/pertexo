import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ArtifactUploadNotFoundError,
  createArtifactUploadDatabase,
} from '../src/artifacts/upload.js';

import {
  Pool,
  adminUrl,
  createRunArtifactRetentionCoordinator,
  maintenanceUrl,
  migrationUrl,
  owner,
  parseDatabaseConfig,
  randomUUID,
  runIds,
  withApplicationName,
  workspaceId,
  userId,
} from './support/retention.integration.support.js';

async function readCapacity(): Promise<{
  chargedBytes: number;
  chargedCount: number;
}> {
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await owner.query<{
      charged_bytes: number | string;
      charged_count: number;
    }>(
      `select charged_bytes,charged_count
         from app.workspace_artifact_capacity where workspace_id=$1`,
      [workspaceId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('artifact capacity row missing');
    await owner.query('commit');
    return {
      chargedBytes: Number(row.charged_bytes),
      chargedCount: row.charged_count,
    };
  } catch (error: unknown) {
    await owner.query('rollback').catch(() => undefined);
    throw error;
  }
}

async function withOwnerTransaction<T>(
  work: (client: typeof owner) => Promise<T>,
): Promise<T> {
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await work(owner);
    await owner.query('commit');
    return result;
  } catch (error: unknown) {
    await owner.query('rollback').catch(() => undefined);
    throw error;
  }
}

async function insertExpiredPendingUserUpload(
  artifactId: string,
  digestCharacter: string,
): Promise<void> {
  await withOwnerTransaction(async (client) => {
    await client.query(
      `insert into app.artifacts
         (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
          status,expires_at)
       values($1,$2,'user-upload',$3,'application/octet-stream',10,$4,
         'pending',clock_timestamp()-interval '1 hour')`,
      [
        artifactId,
        workspaceId,
        `workspaces/${workspaceId}/artifacts/${artifactId}`,
        digestCharacter.repeat(64),
      ],
    );
  });
}

async function readArtifactRetentionState(artifactId: string): Promise<{
  status: string;
  retryScheduled: boolean;
}> {
  return withOwnerTransaction(async (client) => {
    const result = await client.query<{
      status: string;
      retry_scheduled: boolean | null;
    }>(
      `select status,retention_retry_at>clock_timestamp() as retry_scheduled
         from app.artifacts where workspace_id=$1 and id=$2`,
      [workspaceId, artifactId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('artifact retention state missing');
    return {
      status: row.status,
      retryScheduled: row.retry_scheduled === true,
    };
  });
}

async function setArtifactRetryAt(
  artifactId: string,
  value: 'past' | 'null',
): Promise<void> {
  await withOwnerTransaction(async (client) => {
    await client.query(
      value === 'past'
        ? `update app.artifacts
             set retention_retry_at=clock_timestamp()-interval '1 second'
           where workspace_id=$1 and id=$2`
        : `update app.artifacts
             set retention_retry_at=null
           where workspace_id=$1 and id=$2`,
      [workspaceId, artifactId],
    );
  });
}

type ArtifactStoreInput = Readonly<{
  artifactId: string;
  signal?: AbortSignal;
  workspaceId: string;
}>;

beforeEach(async () => {
  await withOwnerTransaction(async (client) => {
    await client.query(
      `update app.workflow_runs
         set input_ref=null,input_ref_expires_at=null,output_ref=null
       where workspace_id=$1`,
      [workspaceId],
    );
    await client.query('delete from app.artifact_links where workspace_id=$1', [
      workspaceId,
    ]);
    await client.query('alter table app.artifacts disable trigger user');
    await client.query('delete from app.artifacts where workspace_id=$1', [
      workspaceId,
    ]);
    await client.query('alter table app.artifacts enable trigger user');
    await client.query(
      `update app.workspace_artifact_capacity
         set charged_bytes=0,charged_count=0,updated_at=clock_timestamp()
       where workspace_id=$1`,
      [workspaceId],
    );
  });
});

describe('retention artifact reclamation', () => {
  it('deletes expired pending user uploads before releasing capacity', async () => {
    const artifactId = randomUUID();
    await insertExpiredPendingUserUpload(artifactId, 'd');

    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: 10,
      chargedCount: 1,
    });
    const artifacts = {
      delete: vi.fn((_input: ArtifactStoreInput) => {
        return Promise.resolve();
      }),
      head: vi.fn((_input: ArtifactStoreInput) => {
        return Promise.resolve(null);
      }),
    };
    const coordinator = createRunArtifactRetentionCoordinator(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
      artifacts,
    );
    try {
      await expect(coordinator.processNext()).resolves.toMatchObject({
        artifactId,
        status: 'completed',
        workspaceId,
      });
    } finally {
      await coordinator.close();
    }

    expect(artifacts.delete).toHaveBeenCalledOnce();
    expect(artifacts.delete.mock.calls[0]?.[0]).toMatchObject({
      artifactId,
      workspaceId,
    });
    expect(artifacts.head).toHaveBeenCalledOnce();
    expect(artifacts.head.mock.calls[0]?.[0]).toMatchObject({
      artifactId,
      workspaceId,
    });
    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: 0,
      chargedCount: 0,
    });
  });

  it('keeps an expired pending upload deleting and charged across a store failure', async () => {
    const artifactId = randomUUID();
    const before = await readCapacity();
    await insertExpiredPendingUserUpload(artifactId, 'e');
    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: before.chargedBytes + 10,
      chargedCount: before.chargedCount + 1,
    });
    const artifacts = {
      delete: vi
        .fn()
        .mockRejectedValueOnce(new Error('artifact store unavailable'))
        .mockResolvedValue(undefined),
      head: vi
        .fn()
        .mockResolvedValueOnce({ stillPresent: true })
        .mockResolvedValueOnce(null),
    };
    const createCoordinator = () =>
      createRunArtifactRetentionCoordinator(
        parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
        artifacts,
      );
    const coordinator = createCoordinator();
    try {
      await expect(coordinator.processNext()).rejects.toThrow(
        'artifact store unavailable',
      );
      expect(artifacts.head).not.toHaveBeenCalled();
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: before.chargedBytes + 10,
        chargedCount: before.chargedCount + 1,
      });
    } finally {
      await coordinator.close();
    }

    const restartedAfterFailure = createCoordinator();
    try {
      await expect(restartedAfterFailure.processNext()).resolves.toEqual({
        status: 'idle',
      });
      expect(await readArtifactRetentionState(artifactId)).toEqual({
        status: 'deleting',
        retryScheduled: true,
      });
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: before.chargedBytes + 10,
        chargedCount: before.chargedCount + 1,
      });

      await setArtifactRetryAt(artifactId, 'past');
      await expect(restartedAfterFailure.processNext()).resolves.toMatchObject({
        artifactId,
        status: 'waiting',
        workspaceId,
      });
      expect(await readArtifactRetentionState(artifactId)).toEqual({
        status: 'deleting',
        retryScheduled: true,
      });
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: before.chargedBytes + 10,
        chargedCount: before.chargedCount + 1,
      });
    } finally {
      await restartedAfterFailure.close();
    }

    const restartedAfterWaiting = createCoordinator();
    try {
      await expect(restartedAfterWaiting.processNext()).resolves.toEqual({
        status: 'idle',
      });
      expect(await readArtifactRetentionState(artifactId)).toEqual({
        status: 'deleting',
        retryScheduled: true,
      });

      await setArtifactRetryAt(artifactId, 'null');
      await expect(restartedAfterWaiting.processNext()).resolves.toMatchObject({
        artifactId,
        status: 'completed',
        workspaceId,
      });
    } finally {
      await restartedAfterWaiting.close();
    }
    expect(artifacts.delete).toHaveBeenCalledTimes(3);
    expect(artifacts.head).toHaveBeenCalledTimes(2);
    await expect(readCapacity()).resolves.toEqual(before);
  });

  it('retains referenced artifacts and deletes unreferenced bytes before metadata', async () => {
    const coordinatorApplication = `retention-artifacts-${workspaceId}`;
    const referencedArtifactId = '00000000-0000-4000-8000-000000000101';
    const expiredArtifactId = '00000000-0000-4000-8000-000000000102';
    const followingArtifactId = '00000000-0000-4000-8000-000000000103';
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        'alter table app.artifacts no force row level security',
      );
      await owner.query(
        'alter table app.workflow_runs no force row level security',
      );
      for (const artifactId of [
        referencedArtifactId,
        expiredArtifactId,
        followingArtifactId,
      ]) {
        await owner.query(
          `insert into app.artifacts
            (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
             status,expires_at,finalized_at)
           values($1,$2,'node-output',$3,'application/json',10,$4,
             'available','2026-07-01T00:00:00Z','2026-06-01T00:00:00Z')`,
          [
            artifactId,
            workspaceId,
            `workspaces/${workspaceId}/artifacts/${artifactId}`,
            'a'.repeat(64),
          ],
        );
      }
      await owner.query(
        `update app.workflow_runs set output_ref=$2::jsonb where id=$1`,
        [
          runIds[3],
          JSON.stringify({
            artifactId: referencedArtifactId,
            kind: 'artifact',
            schemaVersion: 1,
          }),
        ],
      );
      await owner.query('alter table app.artifacts force row level security');
      await owner.query(
        'alter table app.workflow_runs force row level security',
      );
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: 30,
      chargedCount: 3,
    });
    let releaseDelete: (() => void) | undefined;
    const deleteStarted = Promise.withResolvers<undefined>();
    const artifacts = {
      delete: vi
        .fn(() => Promise.resolve())
        .mockImplementationOnce(() => Promise.resolve())
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              releaseDelete = resolve;
              deleteStarted.resolve(undefined);
            }),
        ),
      head: vi
        .fn()
        .mockResolvedValueOnce({ stillPresent: true })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
    };
    const coordinator = createRunArtifactRetentionCoordinator(
      parseDatabaseConfig({
        connectionString: withApplicationName(
          maintenanceUrl,
          coordinatorApplication,
        ),
        max: 2,
      }),
      artifacts,
    );
    let following: Promise<unknown> | undefined;
    try {
      await expect(coordinator.processNext()).resolves.toMatchObject({
        artifactId: referencedArtifactId,
        status: 'referenced',
      });
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: 30,
        chargedCount: 3,
      });
      await expect(coordinator.processNext()).resolves.toMatchObject({
        artifactId: expiredArtifactId,
        status: 'waiting',
      });
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: 30,
        chargedCount: 3,
      });
      const writer = new Pool({ connectionString: migrationUrl, max: 1 });
      try {
        await writer.query('begin');
        await writer.query('set local role pertexo_owner');
        await writer.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await writer.query(
          'update app.workflow_runs set output_ref=$2::jsonb where id=$1',
          [
            runIds[3],
            JSON.stringify({
              artifactId: followingArtifactId,
              kind: 'artifact',
              schemaVersion: 1,
            }),
          ],
        );
        // The writer holds the artifact while it adds a reference, so cleanup
        // passes it by instead of waiting.
        await expect(coordinator.processNext()).resolves.toEqual({
          status: 'idle',
        });
        await writer.query('rollback');
        following = coordinator.processNext();
        await deleteStarted.promise;
        await expect(readCapacity()).resolves.toEqual({
          chargedBytes: 30,
          chargedCount: 3,
        });
        const monitor = new Pool({ connectionString: adminUrl, max: 1 });
        try {
          const transaction = await monitor.query<{ open: boolean }>(
            `select exists (
               select 1 from pg_stat_activity
                where application_name=$1 and xact_start is not null
             ) open`,
            [coordinatorApplication],
          );
          expect(transaction.rows[0]).toEqual({ open: false });
        } finally {
          await monitor.end();
          releaseDelete?.();
        }
        await expect(following).resolves.toMatchObject({
          artifactId: followingArtifactId,
          status: 'completed',
        });
        await expect(readCapacity()).resolves.toEqual({
          chargedBytes: 20,
          chargedCount: 2,
        });
      } finally {
        await writer.query('rollback').catch(() => undefined);
        await writer.end();
      }
      await owner.query('begin');
      try {
        await owner.query('set local role pertexo_owner');
        await owner.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await owner.query(
          `update app.artifacts set retention_retry_at=clock_timestamp()-interval '1 second'
           where id=$1`,
          [expiredArtifactId],
        );
        await owner.query('commit');
      } catch (error: unknown) {
        await owner.query('rollback').catch(() => undefined);
        throw error;
      }
      await expect(coordinator.processNext()).resolves.toMatchObject({
        artifactId: expiredArtifactId,
        status: 'completed',
      });
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: 10,
        chargedCount: 1,
      });
      expect(artifacts.delete).toHaveBeenCalledTimes(3);
    } finally {
      releaseDelete?.();
      await following?.catch(() => undefined);
      await coordinator.close();
    }

    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        'alter table app.artifacts no force row level security',
      );
      const proof = await owner.query(
        `select id,retention_retry_at is not null retry_scheduled
         from app.artifacts where id=any($1::uuid[]) order by id`,
        [[referencedArtifactId, expiredArtifactId, followingArtifactId]],
      );
      expect(proof.rows).toEqual([
        { id: referencedArtifactId, retry_scheduled: true },
      ]);
      await owner.query('alter table app.artifacts force row level security');
      await owner.query('rollback');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
  });

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
});
