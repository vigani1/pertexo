import { randomUUID } from 'node:crypto';

import {
  createIdentityWorkspaceDatabase,
  createWorkflowAuthoringDatabase,
  testExecutableCompiler,
  type IdentityWorkspaceDatabase,
  type WorkflowAuthoringDatabase,
} from '@pertexo/core/testing';
import {
  migrateDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import {
  JOB_NAME,
  jobIdForOutboxEvent,
  QUEUE_NAME,
  type QueueConsumer,
} from '@pertexo/queue';
import { Queue } from 'bullmq';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { dropDisconnectedDatabase } from './infrastructure/disposable-database.js';
import { createRedisTestNamespace } from './infrastructure/redis-test-namespace.js';
import {
  ownerRole,
  appRole,
  maintenanceRole,
  migrationRole,
  adminUrl,
  migrationBaseUrl,
  apiBaseUrl,
  workerBaseUrl,
  dispatcherBaseUrl,
  configuredRedisUrl,
} from './workflow-lifecycle/environment.js';
import type {
  OwnedResource,
  WorkflowLifecycleWorkerEnvironment,
} from './workflow-lifecycle/contract.js';
import {
  databaseUrl,
  quoteIdentifier,
  bullConnection,
  withTransaction,
} from './workflow-lifecycle/transactions.js';
import {
  seedWorkflowRows,
  seedApiOwnedRows,
} from './workflow-lifecycle/seed.js';
import { createLifecycleReads } from './workflow-lifecycle/queries.js';
import { createLifecycleRuntimes } from './workflow-lifecycle/runtimes.js';
import { createLifecycleResourceOwners } from './workflow-lifecycle/ownership.js';
export { JOB_NAME, jobIdForOutboxEvent };
export type { QueueConsumer };
export {
  workflowLifecycleIntegrationRedisUrl,
  workflowLifecycleIntegrationEnabled,
} from './workflow-lifecycle/environment.js';
export {
  type LifecycleRunKey,
  type LifecycleIds,
  type LifecycleProjection,
  type RunSnapshot,
  type LifecycleOutboxEvent,
  type WorkflowLifecycleWorkerEnvironment,
} from './workflow-lifecycle/contract.js';
export function createWorkflowLifecycleWorkerEnvironment(): WorkflowLifecycleWorkerEnvironment {
  const databaseName = `pertexo_test_worker_lifecycle_${randomUUID().replaceAll('-', '')}`;
  const apiConfig = parseDatabaseConfig({
    connectionString: databaseUrl(apiBaseUrl, databaseName),
    max: 8,
  });
  const workerConfig = parseDatabaseConfig({
    connectionString: databaseUrl(workerBaseUrl, databaseName),
    max: 8,
  });
  const dispatcherConfig = parseDatabaseConfig({
    connectionString: databaseUrl(dispatcherBaseUrl, databaseName),
    max: 2,
  });
  const migrationUrl = databaseUrl(migrationBaseUrl, databaseName);
  const workspaceId = randomUUID();
  const actorId = randomUUID();
  const ids = {
    workflow: randomUUID(),
    version: randomUUID(),
    activeWebhook: randomUUID(),
    activeSchedule: randomUUID(),
    disabledWebhook: randomUUID(),
    disabledSchedule: randomUUID(),
    activeWebhookEndpoint: randomUUID(),
    disabledWebhookEndpoint: randomUUID(),
    activeWebhookSecret: randomUUID(),
    disabledWebhookSecret: randomUUID(),
    runs: {
      queued: randomUUID(),
      running: randomUUID(),
      waiting: randomUUID(),
      succeeded: randomUUID(),
    },
  } as const;
  const redisNamespace = createRedisTestNamespace(
    configuredRedisUrl,
    15,
    'workflow-lifecycle',
  );
  const resources: OwnedResource[] = [];
  let owner: Pool | undefined;
  let apiPool: Pool | undefined;
  let worker: Pool | undefined;
  let identity: IdentityWorkspaceDatabase | undefined;
  let authoring: WorkflowAuthoringDatabase | undefined;
  let queue: Queue | undefined;
  let databaseCreated = false;
  let initialized = false;
  let initializingPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const { registerResource, registerCloseable, transferResource } =
    createLifecycleResourceOwners(resources);
  const requireOwner = (): Pool => {
    if (owner === undefined)
      throw new Error('Workflow lifecycle fixture is not initialized');
    return owner;
  };

  const requireApiPool = (): Pool => {
    if (apiPool === undefined)
      throw new Error('Workflow lifecycle fixture is not initialized');
    return apiPool;
  };

  const requireWorker = (): Pool => {
    if (worker === undefined)
      throw new Error('Workflow lifecycle fixture is not initialized');
    return worker;
  };

  const requireAuthoring = (): WorkflowAuthoringDatabase => {
    if (authoring === undefined)
      throw new Error('Workflow lifecycle fixture is not initialized');
    return authoring;
  };

  const requireQueue = (): Queue => {
    if (queue === undefined)
      throw new Error('Workflow lifecycle fixture is not initialized');
    return queue;
  };

  const ownerQuery = async <Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> =>
    withTransaction<QueryResult<Row>>(
      requireOwner(),
      workspaceId,
      async (client) => {
        return client.query<Row>(statement, [...parameters]);
      },
      ownerRole,
    );

  const workerQuery = async <Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> =>
    withTransaction<QueryResult<Row>>(requireWorker(), workspaceId, (client) =>
      client.query<Row>(statement, [...parameters]),
    );

  const initialize = (): Promise<void> => {
    if (initialized) return Promise.resolve();
    initializingPromise ??= (async () => {
      await redisNamespace.acquire();
      registerCloseable('Redis namespace', redisNamespace);

      const admin = new Pool({ connectionString: adminUrl, max: 1 });
      let setupError: unknown;
      try {
        await admin.query(
          `create database ${quoteIdentifier(databaseName)} owner ${quoteIdentifier(ownerRole)}`,
        );
        databaseCreated = true;
        await admin.query(
          `revoke all on database ${quoteIdentifier(databaseName)} from public`,
        );
        await admin.query(
          `grant connect on database ${quoteIdentifier(databaseName)} to ${[
            migrationRole,
            appRole,
            maintenanceRole,
          ]
            .map(quoteIdentifier)
            .join(',')}`,
        );
      } catch (error: unknown) {
        setupError = error;
      }
      try {
        await admin.end();
      } catch (error: unknown) {
        setupError =
          setupError === undefined
            ? error
            : new AggregateError(
                [setupError, error],
                'Workflow lifecycle database setup failed',
              );
      }
      if (setupError !== undefined)
        throw setupError instanceof Error
          ? setupError
          : new Error('Workflow lifecycle database setup failed', {
              cause: setupError,
            });

      await migrateDatabase({
        connectionString: migrationUrl,
        ownerRole,
        appRole,
        maintenanceRole,
      });

      owner = registerResource(
        'owner pool',
        new Pool({ connectionString: migrationUrl, max: 2 }),
        (pool) => pool.end(),
      );
      apiPool = registerResource(
        'API pool',
        new Pool({
          connectionString: apiConfig.connectionString,
          max: 2,
        }),
        (pool) => pool.end(),
      );
      worker = registerResource(
        'worker pool',
        new Pool({
          connectionString: workerConfig.connectionString,
          max: 2,
        }),
        (pool) => pool.end(),
      );
      identity = registerCloseable(
        'identity database',
        createIdentityWorkspaceDatabase(apiConfig),
      );
      authoring = registerCloseable(
        'authoring database',
        createWorkflowAuthoringDatabase(apiConfig, {
          executableCompiler: testExecutableCompiler,
        }),
      );
      queue = new Queue(QUEUE_NAME.triggerLifecycle, {
        connection: bullConnection(redisNamespace.redisUrl),
      });
      registerResource('trigger lifecycle queue', queue, async (ownedQueue) => {
        const errors: unknown[] = [];
        await ownedQueue
          .obliterate({ force: true })
          .catch((error: unknown) => errors.push(error));
        await ownedQueue.close().catch((error: unknown) => errors.push(error));
        if (errors.length > 0)
          throw new AggregateError(
            errors,
            'Trigger lifecycle queue cleanup failed',
          );
      });

      await identity.createUser({
        id: actorId,
        email: `worker-lifecycle-${actorId}@example.test`,
        displayName: 'Worker lifecycle owner',
      });
      await identity.createWorkspaceWithOwner({
        id: workspaceId,
        name: 'Worker lifecycle workspace',
        slug: `worker-lifecycle-${actorId}`,
        ownerUserId: actorId,
        idempotencyKey: `worker-lifecycle-${actorId}`,
      });
      await withTransaction(
        requireOwner(),
        workspaceId,
        (client) => seedWorkflowRows(client, workspaceId, actorId, ids),
        ownerRole,
      );
      await withTransaction(requireApiPool(), workspaceId, (client) =>
        seedApiOwnedRows(client, workspaceId, actorId, ids),
      );
      await requireQueue().obliterate({ force: true });
      initialized = true;
    })().catch(async (initializationError: unknown) => {
      let cleanupError: unknown;
      await close().catch((error: unknown) => {
        cleanupError = error;
      });
      if (cleanupError === undefined) throw initializationError;
      throw new AggregateError(
        [initializationError, cleanupError],
        'Workflow lifecycle fixture initialization failed',
      );
    });
    return initializingPromise;
  };

  const { readProjection, readRunSnapshot, readOutboxEvent } =
    createLifecycleReads({ requireOwner, requireWorker, workspaceId, ids });
  const { createRuntime, createDispatcher } = createLifecycleRuntimes({
    registerCloseable,
    transferResource,
    workerConfig,
    dispatcherConfig,
    redisNamespace,
  });
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      const errors: unknown[] = [];
      for (const resource of resources.splice(0).reverse())
        await resource.close().catch((cause: unknown) => {
          errors.push(
            new Error(
              `Workflow lifecycle fixture cleanup failed: ${resource.label}`,
              { cause },
            ),
          );
        });
      if (databaseCreated) {
        const admin = new Pool({ connectionString: adminUrl, max: 1 });
        await dropDisconnectedDatabase(admin, databaseName).catch(
          (cause: unknown) => {
            errors.push(
              new Error(
                'Workflow lifecycle fixture cleanup failed: drop database',
                { cause },
              ),
            );
          },
        );
        await admin.end().catch((cause: unknown) => {
          errors.push(
            new Error('Workflow lifecycle fixture cleanup failed: admin pool', {
              cause,
            }),
          );
        });
        databaseCreated = false;
      }
      if (errors.length > 0)
        throw new AggregateError(
          errors,
          'Workflow lifecycle fixture cleanup failed',
        );
    })();
    return closePromise;
  };

  return Object.freeze({
    apiConfig,
    workerConfig,
    dispatcherConfig,
    actorId,
    workspaceId,
    ids,
    get authoring() {
      return requireAuthoring();
    },
    get queue() {
      return requireQueue();
    },
    initialize,
    ownerQuery,
    workerQuery,
    transition: (
      command: 'archive' | 'restore',
      expectedLifecycleRevision: number,
      idempotencyKey: string,
    ) =>
      requireAuthoring().transitionWorkflowLifecycle({
        actorId,
        command,
        expectedLifecycleRevision,
        idempotencyKey,
        workflowId: ids.workflow,
        workspaceId,
      }),
    readProjection,
    readRunSnapshot,
    readOutboxEvent,
    makeDue: async (id: string) => {
      await ownerQuery(
        `update app.outbox_events set available_at=clock_timestamp() where id=$1`,
        [id],
      );
    },
    createRuntime,
    createDispatcher,
    close,
  });
}
