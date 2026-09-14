import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';

import {
  canonicalOutboxPayloadChecksum,
  consumeInboxMessage,
  createOutboxDispatcherDatabase,
  createWorkspaceDatabase,
  insertOutboxEvent,
  migrateDatabase,
  parseDatabaseConfig,
  parseMigrationConfig,
} from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME, QUEUE_NAME } from '@pertexo/queue';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { Pool, type PoolClient } from 'pg';

import { WorkerDrainState } from '../../src/runtime/worker-drain-state.js';
import {
  createDispatchConsumerCapabilityRegistry,
  type DispatchConsumerCapabilityRegistry,
} from '../../src/transport/dispatch-consumer-capabilities.js';
import { OutboxDispatcher } from '../../src/transport/outbox-dispatcher.js';
import { dropDisconnectedDatabase } from './disposable-database.js';

export function createTransportTestCleanupStack(stage: string) {
  const owners: { close: () => unknown; label: string }[] = [];
  let closed = false;
  return Object.freeze({
    add(label: string, close: () => unknown): () => Promise<void> {
      if (closed)
        throw new Error(`Cannot register ${label} after ${stage} cleanup`);
      let closePromise: Promise<void> | undefined;
      const closeOnce = (): Promise<void> => {
        closePromise ??= Promise.resolve()
          .then(close)
          .then(() => undefined);
        return closePromise;
      };
      owners.push({ close: closeOnce, label });
      return closeOnce;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      for (const owner of owners.reverse())
        await Promise.resolve()
          .then(owner.close)
          .catch((cause: unknown) => {
            errors.push(
              new Error(`${stage} cleanup failed: ${owner.label}`, { cause }),
            );
          });
      if (errors.length > 0)
        throw new AggregateError(errors, `${stage} cleanup failed`);
    },
  });
}

export async function listenOnLoopback(server: Server): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      server.removeListener('error', onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    server.once('error', onError);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Worker transport provider listen timed out'));
    }, 5_000);
    timer.unref();
    server.listen(0, '127.0.0.1', () => {
      cleanup();
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Worker transport provider did not bind to TCP');
  return address.port;
}

export async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

export function createWorkerTransportTestEnvironment() {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const configuredMigrationUrl =
    process.env.DATABASE_MIGRATION_URL ??
    'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
  const configuredApiUrl =
    process.env.DATABASE_API_URL ??
    'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
  const configuredWorkerUrl =
    process.env.DATABASE_WORKER_URL ??
    'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
  const configuredDispatcherUrl =
    process.env.DATABASE_DISPATCHER_URL ??
    'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo';
  const configuredRedisUrl =
    process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';

  const databaseName = `pertexo_test_transport_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = (base: string): string => {
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    return url.toString();
  };
  const migrationUrl = databaseUrl(configuredMigrationUrl);
  const apiUrl = databaseUrl(configuredApiUrl);
  const workerUrl = databaseUrl(configuredWorkerUrl);
  const dispatcherUrl = databaseUrl(configuredDispatcherUrl);
  const redisUrl = (() => {
    const url = new URL(configuredRedisUrl);
    url.pathname = '/11';
    return url.toString();
  })();

  const workspaceId = randomUUID();
  const actorId = randomUUID();
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
        `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
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

  const applyLedgerFixture = async (): Promise<void> => {
    const source = await readFile(
      new URL(
        '../../../../packages/database/test/fixtures/queue-duplicate-proof.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const fixture = source
      .replaceAll('{{api_runtime_role}}', 'pertexo_api')
      .replaceAll('{{worker_runtime_role}}', 'pertexo_worker');
    const pool = new Pool({ connectionString: migrationUrl, max: 1 });
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query(fixture);
      await client.query(
        `insert into app.users (id,email,display_name)
         values ($1,$2,'Worker transport proof') on conflict (id) do nothing`,
        [actorId, `worker-transport-${actorId}@example.test`],
      );
      await client.query(
        `insert into app.workspaces (id,name,slug,created_by)
         values ($1,'Worker transport proof',$2,$3) on conflict (id) do nothing`,
        [workspaceId, `worker-transport-${workspaceId}`, actorId],
      );
      await client.query('commit');
    } catch (error: unknown) {
      await client?.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client?.release();
      await pool.end();
    }
  };

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

  const insertRunEvent = async (
    id = randomUUID(),
    traceparent?: string,
  ): Promise<string> => {
    proofIds.add(id);
    const payload = {
      runId: randomUUID(),
      ...(traceparent ? { traceparent } : {}),
    };
    await requireApiDatabase().withWorkspace(
      workspaceId,
      async (transaction) => {
        await transaction.db.execute(sql`
        insert into app.workflow_runs (
          id,workspace_id,workflow_id,workflow_version_id,trigger_type,status
        ) values (
          ${payload.runId},${workspaceId},${randomUUID()},${randomUUID()},'manual','succeeded'
        )
      `);
        await insertOutboxEvent(transaction, {
          aggregateId: payload.runId,
          aggregateType: 'workflow-run',
          availableAt: new Date(0),
          id,
          jobName: JOB_NAME.advanceWorkflowRun,
          payload,
          payloadChecksum: checksum(payload),
          schemaVersion: 1,
        });
      },
    );
    return id;
  };

  const consumeProof = async (
    messageId: string,
    logicalAttemptId: string,
    providerIntent?: Readonly<{
      attemptId: string;
      idempotencyKey: string;
      nodeRunId: string;
      outboxEventId: string;
      runId: string;
      traceparent?: string;
    }>,
  ) =>
    consumeInboxMessage(
      requireWorkerDatabase(),
      workspaceId,
      {
        consumerName: 'worker.phase0-proof',
        messageId,
        payloadChecksum: checksum({ logicalAttemptId }),
      },
      async (transaction) => {
        const { db, workspaceId: activeWorkspaceId } = transaction;
        await db.execute(sql`
          insert into app.queue_duplicate_probe_attempts
            (id, workspace_id, logical_attempt_id)
          values (${randomUUID()}, ${activeWorkspaceId}, ${logicalAttemptId})
        `);
        await db.execute(sql`
          insert into app.queue_duplicate_probe_events
            (id, workspace_id, logical_attempt_id, sequence)
          values (${randomUUID()}, ${activeWorkspaceId}, ${logicalAttemptId}, 1)
        `);
        await db.execute(sql`
          insert into app.queue_duplicate_probe_usage
            (id, workspace_id, idempotency_key, quantity)
          values (${randomUUID()}, ${activeWorkspaceId}, ${`usage:${logicalAttemptId}`}, 1)
        `);
        if (providerIntent !== undefined) {
          const payload = {
            attemptId: providerIntent.attemptId,
            nodeRunId: providerIntent.nodeRunId,
            runId: providerIntent.runId,
            ...(providerIntent.traceparent
              ? { traceparent: providerIntent.traceparent }
              : {}),
          };
          await insertOutboxEvent(transaction, {
            aggregateId: providerIntent.attemptId,
            aggregateType: 'provider-intent',
            id: providerIntent.outboxEventId,
            jobName: JOB_NAME.executeNodeAttempt,
            payload,
            payloadChecksum: checksum(payload),
            schemaVersion: 1,
          });
          await db.execute(sql`
            insert into app.queue_duplicate_probe_provider_intents
              (
                id,
                workspace_id,
                logical_attempt_id,
                outbox_event_id,
                idempotency_key
              )
            values (
              ${providerIntent.attemptId},
              ${activeWorkspaceId},
              ${logicalAttemptId},
              ${providerIntent.outboxEventId},
              ${providerIntent.idempotencyKey}
            )
          `);
        }
        return logicalAttemptId;
      },
    );

  const dispatchFairRounds = async (
    dispatchers: readonly OutboxDispatcher[],
    expectedClaims: number,
  ): Promise<
    Readonly<{ claimed: number; failed: number; published: number }>
  > => {
    const totals = { claimed: 0, failed: 0, published: 0 };
    const maximumRounds = expectedClaims + 2;
    for (let round = 0; round < maximumRounds; round += 1) {
      const results = await Promise.all(
        dispatchers.map((dispatcher) => dispatcher.dispatchOnce()),
      );
      for (const result of results) {
        totals.claimed += result.claimed;
        totals.failed += result.failed;
        totals.published += result.published;
      }
      if (totals.claimed >= expectedClaims) return totals;
    }
    throw new Error(
      `Fair dispatch did not claim ${String(expectedClaims)} events within ${String(maximumRounds)} rounds: ${JSON.stringify(totals)}`,
    );
  };

  const readyCapabilities = (
    jobNames: readonly (typeof JOB_NAME)[keyof typeof JOB_NAME][],
  ): DispatchConsumerCapabilityRegistry =>
    createDispatchConsumerCapabilityRegistry(
      jobNames.map((jobName) => ({
        jobName,
        consumer: {
          isReady: () => true,
          waitUntilReady: () => Promise.resolve(),
        },
      })),
    );

  const createDispatcher = (
    owner: string,
    batchSize = 100,
    enabledJobNames: readonly (typeof JOB_NAME)[keyof typeof JOB_NAME][] = [
      JOB_NAME.advanceWorkflowRun,
      JOB_NAME.executeNodeAttempt,
    ],
    consumerCapabilities: DispatchConsumerCapabilityRegistry = readyCapabilities(
      enabledJobNames,
    ),
  ): OutboxDispatcher =>
    new OutboxDispatcher(
      createOutboxDispatcherDatabase(
        parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 }),
      ),
      createQueueProducer({ redisUrl }),
      new WorkerDrainState(),
      {
        batchSize,
        enabledJobNames,
        leaseDurationMillis: 1_000,
        leaseOwner: owner,
        maxAttempts: 3,
        operationTimeoutMillis: 5_000,
        retryDelayMillis: 100,
      },
      undefined,
      consumerCapabilities,
    );

  const deferred = (
    stage: string,
    timeoutMillis = 10_000,
  ): Readonly<{
    dispose(): void;
    promise: Promise<void>;
    reject(reason: unknown): void;
    resolve(): void;
  }> => {
    let resolvePromise: (() => void) | undefined;
    let rejectPromise: ((reason: unknown) => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      ownedDeferreds.delete(dispose);
      operation();
    };
    const dispose = (): void => {
      settle(() => {
        resolvePromise?.();
      });
    };
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
      timer = setTimeout(() => {
        settle(() => {
          reject(new Error(`Worker transport stage timed out: ${stage}`));
        });
      }, timeoutMillis);
      timer.unref();
    });
    ownedDeferreds.add(dispose);
    return {
      dispose,
      promise,
      reject: (reason) => {
        settle(() => {
          rejectPromise?.(reason);
        });
      },
      resolve: () => {
        settle(() => {
          resolvePromise?.();
        });
      },
    };
  };

  const bounded = async <T>(
    stage: string,
    operation: Promise<T>,
    timeoutMillis = 10_000,
  ): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Worker transport stage timed out: ${stage}`));
          }, timeoutMillis);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

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
