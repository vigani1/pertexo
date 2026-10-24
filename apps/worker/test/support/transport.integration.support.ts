import { randomUUID } from 'node:crypto';

import {
  canonicalOutboxPayloadChecksum,
  createWorkspaceDatabase,
  migrateDatabase,
  parseDatabaseConfig,
  parseMigrationConfig,
} from '@pertexo/database/testing';
import { QUEUE_NAME } from '@pertexo/queue';
import { Queue } from 'bullmq';

import { Redis } from 'ioredis';
import { Pool, type PoolClient } from 'pg';

import { dropDisconnectedDatabase } from './infrastructure/disposable-database.js';
import { transportFixtureSettings } from './transport/environment.js';
import { createTransportLedgerSetup } from './transport/ledger.js';
import { createTransportProofOperations } from './transport/proofs.js';
import { createTransportDispatchControls } from './transport/dispatch.js';
import { createTransportProofWaits } from './transport/waits.js';

export { createTransportTestCleanupStack } from './transport/cleanup.js';
export { listenOnLoopback, closeHttpServer } from './transport/server.js';
export function createWorkerTransportTestEnvironment() {
  const {
    adminUrl,
    databaseName,
    migrationUrl,
    apiUrl,
    workerUrl,
    dispatcherUrl,
    redisUrl,
    workspaceId,
    actorId,
  } = transportFixtureSettings();
  let apiDatabase: ReturnType<typeof createWorkspaceDatabase> | undefined;
  let workerDatabase: ReturnType<typeof createWorkspaceDatabase> | undefined;
  let databaseCreated = false;
  let redisNamespaceOwner: Redis | undefined;
  const redisNamespaceToken = randomUUID();
  const redisNamespaceLock = 'pertexo:test:worker-transport:owner';
  const proofIds = new Set<string>();
  const ownedDeferreds = new Set<() => void>();

  const requireApiDatabase = (): ReturnType<typeof createWorkspaceDatabase> => {
    if (apiDatabase === undefined)
      throw new Error('Worker transport test environment is not initialized');
    return apiDatabase;
  };

  const requireWorkerDatabase = (): ReturnType<
    typeof createWorkspaceDatabase
  > => {
    if (workerDatabase === undefined)
      throw new Error('Worker transport test environment is not initialized');
    return workerDatabase;
  };

  const checksum = (value: unknown): string =>
    canonicalOutboxPayloadChecksum(value);

  const redisConnection = (): {
    db: number;
    host: string;
    password?: string;
    port: number;
  } => {
    const url = new URL(redisUrl);
    return {
      db: Number(url.pathname.slice(1) || '0'),
      host: url.hostname,
      port: Number(url.port || 6379),
      ...(url.password === ''
        ? {}
        : { password: decodeURIComponent(url.password) }),
    };
  };

  const createDisposableDatabase = async (): Promise<void> => {
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await admin.query(
        `create database "${databaseName}" owner pertexo_owner`,
      );
      databaseCreated = true;
      await admin.query(`revoke all on database "${databaseName}" from public`);
      await admin.query(
        `grant connect on database "${databaseName}" to pertexo_migration, pertexo_app, pertexo_app, pertexo_maintenance`,
      );
    } finally {
      await admin.end();
    }
  };

  const dropDisposableDatabase = async (): Promise<void> => {
    if (!databaseCreated) return;
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await dropDisconnectedDatabase(admin, databaseName);
      databaseCreated = false;
    } finally {
      await admin.end();
    }
  };

  const acquireRedisNamespace = async (): Promise<void> => {
    const owner = new Redis(redisUrl, {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    owner.on('error', () => undefined);
    try {
      await owner.connect();
      const acquired = await owner.set(
        redisNamespaceLock,
        redisNamespaceToken,
        'PX',
        600_000,
        'NX',
      );
      if (acquired !== 'OK')
        throw new Error('Worker transport Redis namespace is already owned');
      if ((await owner.dbsize()) !== 1) {
        await owner.del(redisNamespaceLock);
        throw new Error('Worker transport Redis namespace is not empty');
      }
      redisNamespaceOwner = owner;
    } catch (error: unknown) {
      owner.disconnect(false);
      throw error;
    }
  };

  const releaseRedisNamespace = async (): Promise<void> => {
    const owner = redisNamespaceOwner;
    if (owner === undefined) return;
    redisNamespaceOwner = undefined;
    try {
      const released = await owner.eval(
        `if redis.call('get',KEYS[1]) == ARGV[1] then
           return redis.call('flushdb')
         end
         return 'not-owned'`,
        1,
        redisNamespaceLock,
        redisNamespaceToken,
      );
      if (released !== 'OK')
        throw new Error('Worker transport Redis namespace ownership was lost');
      await owner.quit();
    } catch (error: unknown) {
      owner.disconnect(false);
      throw error;
    }
  };

  const { applyLedgerFixture } = createTransportLedgerSetup({
    migrationUrl,
    workspaceId,
    actorId,
  });
  const initialize = async (): Promise<void> => {
    let initializationError: unknown;
    try {
      await createDisposableDatabase();
      await migrateDatabase(
        parseMigrationConfig({
          ...process.env,
          DATABASE_MIGRATION_URL: migrationUrl,
          NODE_ENV: 'test',
        }),
      );
      await acquireRedisNamespace();
      apiDatabase = createWorkspaceDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      );
      workerDatabase = createWorkspaceDatabase(
        parseDatabaseConfig({ connectionString: workerUrl, max: 4 }),
      );
      await applyLedgerFixture();
      return;
    } catch (error: unknown) {
      initializationError = error;
    }
    const cleanupErrors: unknown[] = [];
    for (const close of [
      () => workerDatabase?.close(),
      () => apiDatabase?.close(),
      releaseRedisNamespace,
      dropDisposableDatabase,
    ])
      await Promise.resolve()
        .then(close)
        .catch((error: unknown) => cleanupErrors.push(error));
    workerDatabase = undefined;
    apiDatabase = undefined;
    throw new AggregateError(
      [initializationError, ...cleanupErrors],
      'Worker transport test environment initialization failed',
    );
  };

  const { insertRunEvent, consumeProof } = createTransportProofOperations({
    proofIds,
    requireApiDatabase,
    requireWorkerDatabase,
    workspaceId,
    checksum,
  });
  const { dispatchFairRounds, createDispatcher } =
    createTransportDispatchControls({ dispatcherUrl, redisUrl });
  const { deferred, bounded } = createTransportProofWaits(ownedDeferreds);
  const cleanup = async (): Promise<void> => {
    const pool = new Pool({ connectionString: migrationUrl, max: 1 });
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      for (const table of [
        'queue_duplicate_probe_provider_effects',
        'queue_duplicate_probe_provider_intents',
        'queue_duplicate_probe_acceptances',
        'queue_duplicate_probe_usage',
        'queue_duplicate_probe_events',
        'queue_duplicate_probe_attempts',
        'inbox_receipts',
        'outbox_events',
        'workflow_runs',
      ]) {
        await client.query(`delete from app.${table} where workspace_id = $1`, [
          workspaceId,
        ]);
      }
      await client.query('commit');
    } catch (error: unknown) {
      await client?.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client?.release();
      await pool.end();
    }
  };

  const close = async (): Promise<void> => {
    for (const dispose of [...ownedDeferreds]) dispose();
    const cleanupErrors: unknown[] = [];
    const attempt = async (
      stage: string,
      operation: () => unknown,
    ): Promise<void> => {
      await Promise.resolve()
        .then(operation)
        .catch((cause: unknown) => {
          cleanupErrors.push(
            new Error(`Worker transport cleanup failed: ${stage}`, { cause }),
          );
        });
    };

    const pool = new Pool({ connectionString: migrationUrl, max: 1 });
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      const discovered = await client.query<{ id: string }>(
        'select id from app.outbox_events where workspace_id = $1',
        [workspaceId],
      );
      for (const { id } of discovered.rows) proofIds.add(id);
      await client.query('commit');
    } catch (error: unknown) {
      await client?.query('rollback').catch(() => undefined);
      cleanupErrors.push(
        new Error('Worker transport cleanup failed: discover outbox IDs', {
          cause: error,
        }),
      );
    } finally {
      client?.release();
      await attempt('close discovery pool', () => pool.end());
    }

    const queues: Queue[] = [];
    for (const queueName of new Set(Object.values(QUEUE_NAME)))
      try {
        queues.push(
          new Queue(queueName, {
            connection: redisConnection(),
          }),
        );
      } catch (error: unknown) {
        cleanupErrors.push(
          new Error(
            `Worker transport cleanup failed: open queue ${queueName}`,
            {
              cause: error,
            },
          ),
        );
      }

    for (const queue of queues)
      for (const id of proofIds)
        await attempt(`remove ${queue.name}/outbox-${id}`, () =>
          bounded(
            `remove ${queue.name}/outbox-${id}`,
            queue.getJob(`outbox-${id}`).then((job) => job?.remove()),
          ),
        );

    const residualJobs: string[] = [];
    for (const queue of queues)
      for (const id of proofIds) {
        const jobId = `outbox-${id}`;
        await attempt(`verify removal ${queue.name}/${jobId}`, async () => {
          if (
            (await bounded(
              `verify removal ${queue.name}/${jobId}`,
              queue.getJob(jobId),
            )) !== undefined
          )
            residualJobs.push(`${queue.name}/${jobId}`);
        });
      }
    if (residualJobs.length > 0)
      cleanupErrors.push(
        new Error(
          `Worker transport cleanup left Bull jobs: ${residualJobs.join(', ')}`,
        ),
      );

    await attempt('database cleanup', () =>
      bounded('database cleanup', cleanup()),
    );
    for (const queue of queues)
      await attempt(`close queue ${queue.name}`, () => queue.close());
    await attempt('close API database', () => apiDatabase?.close());
    await attempt('close worker database', () => workerDatabase?.close());
    apiDatabase = undefined;
    workerDatabase = undefined;
    await attempt('release Redis namespace', releaseRedisNamespace);
    await attempt('drop disposable database', dropDisposableDatabase);

    if (cleanupErrors.length > 0)
      throw new AggregateError(
        cleanupErrors,
        'Worker transport test environment cleanup failed',
      );
  };

  return {
    get apiDatabase() {
      return requireApiDatabase();
    },
    bounded,
    checksum,
    close,
    consumeProof,
    createDispatcher,
    deferred,
    dispatchFairRounds,
    dispatcherUrl,
    initialize,
    insertRunEvent,
    redisConnection,
    redisUrl,
    get workerDatabase() {
      return requireWorkerDatabase();
    },
    workspaceId,
  };
}
