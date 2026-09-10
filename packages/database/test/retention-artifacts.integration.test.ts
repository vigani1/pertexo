import { describe, expect, it, vi } from 'vitest';

import {
  ArtifactUploadConflictError,
  createArtifactUploadDatabase,
} from '../src/execution/artifact-upload.js';
import {
  acquireWorkspaceDestructiveOperationLock,
  releaseWorkspaceDestructiveOperationLock,
  withWorkspaceDestructiveOperationLock,
} from '../src/lifecycle/retention-transaction.js';

import {
  type ControlLedger,
  Pool,
  adminUrl,
  createRunArtifactRetentionCoordinator,
  maintenanceUrl,
  migrationUrl,
  owner,
  parseDatabaseConfig,
  randomUUID,
  runIds,
  waitForPostgresLock,
  withApplicationName,
  workspaceId,
  userId,
  zeroHash,
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

describe('retention artifact reclamation', () => {
  it('deletes expired pending user uploads before releasing capacity', async () => {
    const artifactId = randomUUID();
    await insertExpiredPendingUserUpload(artifactId, 'd');

    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: 10,
      chargedCount: 1,
    });
    const ledger = {
      append: vi.fn(),
      reconcile: vi.fn(() =>
        Promise.resolve({
          hasMore: false,
          pageEndHash: zeroHash,
          pageEndSequence: 0,
          reachedHighWater: true,
          records: [],
        }),
      ),
    } satisfies ControlLedger;
    const artifacts = {
      delete: vi.fn((input: ArtifactStoreInput) => {
        void input;
        return Promise.resolve();
      }),
      head: vi.fn((input: ArtifactStoreInput) => {
        void input;
        return Promise.resolve(null);
      }),
    };
    const coordinator = createRunArtifactRetentionCoordinator(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
      ledger,
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

    const ledger = {
      append: vi.fn(),
      reconcile: vi.fn(() =>
        Promise.resolve({
          hasMore: false,
          pageEndHash: zeroHash,
          pageEndSequence: 0,
          reachedHighWater: true,
          records: [],
        }),
      ),
    } satisfies ControlLedger;
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
        ledger,
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

    const ledger = {
      append: vi.fn(),
      reconcile: vi.fn(() =>
        Promise.resolve({
          hasMore: false,
          pageEndHash: zeroHash,
          pageEndSequence: 0,
          reachedHighWater: true,
          records: [],
        }),
      ),
    } satisfies ControlLedger;
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
      ledger,
      artifacts,
    );
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
        let settled = false;
        const following = coordinator.processNext().then((result) => {
          settled = true;
          return result;
        });
        await waitForPostgresLock(coordinatorApplication);
        expect(settled).toBe(false);
        await writer.query('rollback');
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

  it('serializes late upload verification with expiry cleanup', async () => {
    const applicationName = `retention-finalize-${randomUUID()}`;
    const apiUrl = new URL(
      process.env.DATABASE_API_URL ??
        'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo',
    );
    apiUrl.pathname = new URL(maintenanceUrl).pathname;
    const uploadDatabase = createArtifactUploadDatabase(
      parseDatabaseConfig({ connectionString: apiUrl.toString(), max: 2 }),
    );
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
    const releaseVerification = Promise.withResolvers<undefined>();
    let replicaBytesPresent = false;

    const finalization = uploadDatabase
      .finalizeUpload({
        actor,
        expectedMetadata: metadata,
        identity: { artifactId: created.artifact.id, workspaceId },
        verifyUpload: async () => {
          verificationStarted.resolve(undefined);
          await releaseVerification.promise;
          replicaBytesPresent = true;
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

    const ledger = {
      append: vi.fn(),
      reconcile: vi.fn(() =>
        Promise.resolve({
          hasMore: false,
          pageEndHash: zeroHash,
          pageEndSequence: 0,
          reachedHighWater: true,
          records: [],
        }),
      ),
    } satisfies ControlLedger;
    const artifacts = {
      delete: vi.fn(() => {
        replicaBytesPresent = false;
        return Promise.resolve();
      }),
      head: vi.fn(() => Promise.resolve(null)),
    };
    const coordinator = createRunArtifactRetentionCoordinator(
      parseDatabaseConfig({
        connectionString: withApplicationName(maintenanceUrl, applicationName),
        max: 2,
      }),
      ledger,
      artifacts,
    );
    try {
      let retentionSettled = false;
      const retentionResult = coordinator.processNext().then((result) => {
        retentionSettled = true;
        return result;
      });
      await waitForPostgresLock(applicationName);
      expect(retentionSettled).toBe(false);
      expect(artifacts.delete).not.toHaveBeenCalled();

      releaseVerification.resolve(undefined);
      await expect(finalization).resolves.toBeInstanceOf(
        ArtifactUploadConflictError,
      );
      expect(replicaBytesPresent).toBe(true);
      await expect(retentionResult).resolves.toMatchObject({
        artifactId: created.artifact.id,
        status: 'completed',
        workspaceId,
      });
      expect(replicaBytesPresent).toBe(false);
      expect(artifacts.delete).toHaveBeenCalledOnce();
      await expect(readCapacity()).resolves.toEqual(capacityBefore);
    } finally {
      releaseVerification.resolve(undefined);
      await coordinator.close();
      await uploadDatabase.close();
    }
  });

  it('cancels a PostgreSQL lock wait and returns its connection promptly', async () => {
    const applicationName = `retention-cancel-${randomUUID()}`;
    const holderPool = new Pool({ connectionString: maintenanceUrl, max: 1 });
    const waiterPool = new Pool({
      connectionString: withApplicationName(maintenanceUrl, applicationName),
      max: 2,
    });
    const holder = await holderPool.connect();
    let holderLocked = false;
    let settledOperation: Promise<void> | undefined;
    const work = vi.fn(() => Promise.resolve());
    try {
      await acquireWorkspaceDestructiveOperationLock(holder, workspaceId);
      holderLocked = true;
      const controller = new AbortController();
      const operation = withWorkspaceDestructiveOperationLock(
        waiterPool,
        workspaceId,
        controller.signal,
        work,
      );
      const unsettled = Symbol('unsettled');
      let outcome: unknown = unsettled;
      settledOperation = operation.then(
        () => {
          outcome = undefined;
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      await waitForPostgresLock(applicationName);

      const cancellation = new Error(
        'cancelled while waiting for lifecycle lock',
      );
      controller.abort(cancellation);
      await vi.waitFor(
        () => {
          expect(outcome).toBe(cancellation);
        },
        {
          timeout: 1_000,
        },
      );
      expect(waiterPool.totalCount).toBe(0);
      expect(work).not.toHaveBeenCalled();

      await releaseWorkspaceDestructiveOperationLock(holder, workspaceId);
      holderLocked = false;
      await expect(
        withWorkspaceDestructiveOperationLock(
          waiterPool,
          workspaceId,
          undefined,
          () => Promise.resolve('lock-released'),
        ),
      ).resolves.toBe('lock-released');
    } finally {
      if (holderLocked)
        await releaseWorkspaceDestructiveOperationLock(holder, workspaceId);
      await settledOperation;
      holder.release();
      await holderPool.end();
      await waiterPool.end();
    }
  });

  it('does not mistake an undefined destructive-work rejection for success', async () => {
    const pool = new Pool({ connectionString: maintenanceUrl, max: 2 });
    let rejected = false;
    try {
      await withWorkspaceDestructiveOperationLock(
        pool,
        workspaceId,
        undefined,
        // Deliberately exercise a hostile non-Error adapter rejection.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        () => Promise.reject(undefined),
      );
    } catch (error) {
      rejected = true;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        'Workspace destructive operation failed',
      );
      expect(Object.hasOwn(error as Error, 'cause')).toBe(true);
      expect((error as Error).cause).toBeUndefined();
    } finally {
      await expect(pool.query('select 1')).resolves.toMatchObject({
        rowCount: 1,
      });
      await pool.end();
    }
    expect(rejected).toBe(true);
  });

  it('does not acquire or leak a workspace lock after cancellation while waiting for a pool connection', async () => {
    const queuedPool = new Pool({ connectionString: maintenanceUrl, max: 2 });
    const verifierPool = new Pool({ connectionString: maintenanceUrl, max: 1 });
    const blockers = await Promise.all([
      queuedPool.connect(),
      queuedPool.connect(),
    ]);
    let firstBlockerReleased = false;
    let verifierLocked = false;
    const controller = new AbortController();
    const cancellation = new Error(
      'cancelled while waiting for a database connection',
    );
    const work = vi.fn(() => Promise.resolve());
    const operation = withWorkspaceDestructiveOperationLock(
      queuedPool,
      workspaceId,
      controller.signal,
      work,
    );
    try {
      await vi.waitFor(() => {
        expect(queuedPool.waitingCount).toBe(1);
      });
      controller.abort(cancellation);
      blockers[0].release();
      firstBlockerReleased = true;

      await expect(operation).rejects.toBe(cancellation);
      await vi.waitFor(() => {
        expect(queuedPool.waitingCount).toBe(0);
      });
      expect(work).not.toHaveBeenCalled();

      const lock = await verifierPool.query<{ acquired: boolean }>(
        `select pg_try_advisory_lock(
           hashtextextended($1,1934781127)
         ) acquired`,
        [workspaceId],
      );
      verifierLocked = lock.rows[0]?.acquired === true;
      expect(verifierLocked).toBe(true);
    } finally {
      if (verifierLocked)
        await verifierPool.query(
          `select pg_advisory_unlock(
             hashtextextended($1,1934781127)
           )`,
          [workspaceId],
        );
      if (!firstBlockerReleased) blockers[0].release();
      blockers[1].release();
      await operation.catch(() => undefined);
      await queuedPool.end();
      await verifierPool.end();
    }
  });

  it('does not acknowledge a legal hold while physical deletion is in flight', async () => {
    const artifactId = randomUUID();
    const holdApplicationName = `retention-hold-${randomUUID()}`;
    const before = await readCapacity();
    await insertExpiredPendingUserUpload(artifactId, '9');
    const deleteStarted = Promise.withResolvers<undefined>();
    const releaseDelete = Promise.withResolvers<undefined>();
    const ledger = {
      append: vi.fn(),
      reconcile: vi.fn(() =>
        Promise.resolve({
          hasMore: false,
          pageEndHash: zeroHash,
          pageEndSequence: 0,
          reachedHighWater: true,
          records: [],
        }),
      ),
    } satisfies ControlLedger;
    const artifacts = {
      delete: vi.fn(async () => {
        deleteStarted.resolve(undefined);
        await releaseDelete.promise;
      }),
      head: vi.fn(() => Promise.resolve(null)),
    };
    const coordinator = createRunArtifactRetentionCoordinator(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
      ledger,
      artifacts,
    );
    const hold = new Pool({
      connectionString: withApplicationName(
        maintenanceUrl,
        holdApplicationName,
      ),
      max: 1,
    });
    try {
      const retentionResult = coordinator.processNext();
      await deleteStarted.promise;
      let holdAcknowledged = false;
      const holdResult = hold
        .query(
          `select app.project_workspace_legal_hold(
             $1,1,$2,'legal_hold_placed',$3,$4,$5,
             'legal-admin','case-inflight-delete','serialize hold',$6)`,
          [
            workspaceId,
            randomUUID(),
            randomUUID(),
            zeroHash,
            '8'.repeat(64),
            '2026-09-08T00:00:00.000Z',
          ],
        )
        .then((result) => {
          holdAcknowledged = true;
          return result;
        });
      await waitForPostgresLock(holdApplicationName);
      expect(holdAcknowledged).toBe(false);

      releaseDelete.resolve(undefined);
      await expect(retentionResult).resolves.toMatchObject({
        artifactId,
        status: 'completed',
        workspaceId,
      });
      await expect(holdResult).resolves.toMatchObject({ rowCount: 1 });
      expect(holdAcknowledged).toBe(true);
      await expect(readCapacity()).resolves.toEqual(before);
    } finally {
      releaseDelete.resolve(undefined);
      await coordinator.close();
      await hold.end();
    }
  });

  it('holds an expired user-upload artifact before any object-store operation', async () => {
    const artifactId = randomUUID();
    const holdId = randomUUID();
    const holdHash = 'b'.repeat(64);
    const control = await withOwnerTransaction(async (client) => {
      const result = await client.query<{
        retention_control_hash: string;
        retention_control_sequence: number | string;
      }>(
        `select retention_control_hash,retention_control_sequence
           from app.workspaces where id=$1`,
        [workspaceId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('workspace control state missing');
      return {
        hash: row.retention_control_hash,
        sequence: Number(row.retention_control_sequence),
      };
    });
    const before = await readCapacity();
    const apiUrl = new URL(
      process.env.DATABASE_API_URL ??
        'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo',
    );
    apiUrl.pathname = new URL(maintenanceUrl).pathname;
    const api = new Pool({ connectionString: apiUrl.toString(), max: 1 });
    const maintenance = new Pool({ connectionString: maintenanceUrl, max: 1 });

    try {
      await api.query('begin');
      try {
        await api.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await api.query(
          `insert into app.artifacts
             (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
             status,expires_at)
           values($1,$2,'user-upload',$3,'application/octet-stream',10,$4,
             'pending',clock_timestamp()-interval '1 hour')`,
          [
            artifactId,
            workspaceId,
            `workspaces/${workspaceId}/artifacts/${artifactId}`,
            'c'.repeat(64),
          ],
        );
        await api.query('commit');
      } catch (error: unknown) {
        await api.query('rollback').catch(() => undefined);
        throw error;
      }

      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: before.chargedBytes + 10,
        chargedCount: before.chargedCount + 1,
      });

      await maintenance.query(
        `select app.project_workspace_legal_hold(
          $1,$2,$3,'legal_hold_placed',$4,$5,$6,
          'legal-admin','case-artifact-1','preserve user-upload',$7)`,
        [
          workspaceId,
          control.sequence + 1,
          randomUUID(),
          holdId,
          control.hash,
          holdHash,
          '2026-08-21T00:00:00.000Z',
        ],
      );

      const ledger = {
        append: vi.fn(),
        reconcile: vi.fn(() =>
          Promise.resolve({
            hasMore: false,
            pageEndHash: holdHash,
            pageEndSequence: control.sequence + 1,
            reachedHighWater: true,
            records: [],
          }),
        ),
      } satisfies ControlLedger;
      const artifacts = {
        delete: vi.fn(() => Promise.resolve()),
        head: vi.fn(() => Promise.resolve(null)),
      };
      const coordinator = createRunArtifactRetentionCoordinator(
        parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
        ledger,
        artifacts,
      );
      try {
        await expect(coordinator.processNext()).resolves.toMatchObject({
          artifactId,
          status: 'held',
          workspaceId,
        });
      } finally {
        await coordinator.close();
      }

      expect(artifacts.delete).not.toHaveBeenCalled();
      expect(artifacts.head).not.toHaveBeenCalled();
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: before.chargedBytes + 10,
        chargedCount: before.chargedCount + 1,
      });

      await owner.query('begin');
      try {
        await owner.query('set local role pertexo_owner');
        await owner.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        const proof = await owner.query(
          `select status,purpose,byte_length::text as byte_length,
                  retention_retry_at is not null as retry_scheduled
             from app.artifacts where workspace_id=$1 and id=$2`,
          [workspaceId, artifactId],
        );
        expect(proof.rows).toEqual([
          {
            byte_length: '10',
            purpose: 'user-upload',
            retry_scheduled: true,
            status: 'pending',
          },
        ]);
        await owner.query('commit');
      } catch (error: unknown) {
        await owner.query('rollback').catch(() => undefined);
        throw error;
      }
    } finally {
      await maintenance.end();
      await api.end();
    }
  });
});
