import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import {
  createWorkspaceDatabase,
  migrateDatabase as migrateSchema,
  parseDatabaseConfig,
  parseMigrationConfig,
} from '@pertexo/database/testing';
import {} from '@pertexo/node-catalog';
import { QUEUE_NAME } from '@pertexo/queue';
import { Queue } from 'bullmq';
import { Pool } from 'pg';

import { seedCoordinatorWorkflowFixtures } from './workflows.js';
import { dropDisconnectedDatabase } from '../infrastructure/disposable-database.js';
import { createRedisTestNamespace } from '../infrastructure/redis-test-namespace.js';
import { queryAsWorkspaceRole } from '../workspace-query.js';

const enabled = process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
const execFileAsync = promisify(execFile);
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const workerUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const dispatcherUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';
const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';
const databaseName = `pertexo_test_retained_core_${randomUUID().replaceAll('-', '')}`;
const repositoryRoot = fileURLToPath(
  new URL('../../../../../', import.meta.url),
);
const servicesNeedingRestore = new Set<'postgres' | 'redis'>();

async function compose(...arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync('docker', ['compose', ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return result.stdout.trim();
}

async function stopService(service: 'postgres' | 'redis'): Promise<void> {
  servicesNeedingRestore.add(service);
  await compose('stop', '--timeout', '10', service);
}

async function startService(service: 'postgres' | 'redis'): Promise<number> {
  const startedAt = performance.now();
  await compose('up', '-d', '--wait', service);
  servicesNeedingRestore.delete(service);
  return performance.now() - startedAt;
}

async function restoreServices(): Promise<void> {
  const services = [...servicesNeedingRestore];
  if (services.length === 0) return;
  await compose('up', '-d', '--wait', ...services);
  servicesNeedingRestore.clear();
}

function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const redisNamespace = createRedisTestNamespace(
  configuredRedisUrl,
  12,
  'coordinator-consumer',
);
const redisUrl = redisNamespace.redisUrl;

const actorId = randomUUID();
const workspaceId = randomUUID();
const workflowId = randomUUID();
const workflowVersionId = randomUUID();
const conditionWorkflowId = randomUUID();
const conditionWorkflowVersionId = randomUUID();
const switchWorkflowId = randomUUID();
const switchWorkflowVersionId = randomUUID();
const parallelWorkflowId = randomUUID();
const parallelWorkflowVersionId = randomUUID();
const forEachWorkflowId = randomUUID();
const forEachWorkflowVersionId = randomUUID();
const nestedParallelWorkflowId = randomUUID();
const nestedParallelWorkflowVersionId = randomUUID();
const waitWorkflowId = randomUUID();
const waitWorkflowVersionId = randomUUID();
let ownerPool!: Pool;
let workerPool!: Pool;
let apiDatabase!: ReturnType<typeof createWorkspaceDatabase>;
let ownerPoolCreated = false;
let workerPoolCreated = false;
let apiDatabaseCreated = false;
let databaseCreated = false;
let redisNamespaceAcquired = false;
let cleanupPromise: Promise<void> | undefined;

async function createDatabase(): Promise<void> {
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  let operationError: unknown;
  try {
    await pool.query(`create database "${databaseName}" owner pertexo_owner`);
    databaseCreated = true;
    await pool.query(`revoke all on database "${databaseName}" from public`);
    await pool.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_app, pertexo_app, pertexo_maintenance`,
    );
  } catch (error: unknown) {
    operationError = error;
  }
  await pool.end().catch((error: unknown) => {
    operationError =
      operationError === undefined
        ? error
        : new AggregateError(
            [operationError, error],
            'Coordinator database creation failed',
          );
  });
  if (operationError !== undefined)
    throw operationError instanceof Error
      ? operationError
      : new Error('Coordinator database creation failed', {
          cause: operationError,
        });
}

async function migrateDatabase(): Promise<void> {
  await migrateSchema(
    parseMigrationConfig({
      ...process.env,
      DATABASE_MIGRATION_URL: databaseUrl(migrationUrl),
      NODE_ENV: 'test',
    }),
  );
}

async function dropDatabase(): Promise<void> {
  if (!databaseCreated) return;
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(pool, databaseName);
    databaseCreated = false;
  } finally {
    await pool.end();
  }
}

function redisConnection(): {
  db: number;
  host: string;
  password?: string;
  port: number;
} {
  const parsed = new URL(redisUrl);
  return {
    db: Number(parsed.pathname.slice(1) || '0'),
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password === ''
      ? {}
      : { password: decodeURIComponent(parsed.password) }),
  };
}

async function ownerQuery<T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<readonly T[]> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await client.query<T>(statement, [...parameters]);
    await client.query('commit');
    return result.rows;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function workerQuery<T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<readonly T[]> {
  return queryAsWorkspaceRole<T>(
    workerPool,
    workspaceId,
    statement,
    parameters,
  );
}

async function apiQuery<T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
  manualStart?: Readonly<{ workflowId: string; keyHash: string }>,
): Promise<readonly T[]> {
  const pool = new Pool({
    connectionString: databaseUrl(apiUrl),
    max: 1,
  });
  try {
    return await queryAsWorkspaceRole<T>(
      pool,
      workspaceId,
      statement,
      parameters,
      manualStart === undefined ? undefined : { ...manualStart, actorId },
    );
  } finally {
    await pool.end();
  }
}

async function waitFor<T>(
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await operation();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    value = await operation();
  }
  if (!predicate(value)) {
    throw new Error(
      `coordinator proof timed out with ${JSON.stringify(value)}`,
    );
  }
  return value;
}

async function setupFixture(): Promise<void> {
  try {
    await redisNamespace.acquire();
    redisNamespaceAcquired = true;
    await createDatabase();
    await migrateDatabase();
    ownerPool = new Pool({
      connectionString: databaseUrl(migrationUrl),
      max: 1,
    });
    ownerPoolCreated = true;
    ownerPool.on('error', () => undefined);
    workerPool = new Pool({
      connectionString: databaseUrl(workerUrl),
      max: 2,
    });
    workerPoolCreated = true;
    workerPool.on('error', () => undefined);
    apiDatabase = createWorkspaceDatabase(
      parseDatabaseConfig({ connectionString: databaseUrl(apiUrl), max: 2 }),
    );
    apiDatabaseCreated = true;

    await seedCoordinatorWorkflowFixtures(ownerQuery, {
      actorId,
      workspaceId,
      retained: { workflowId, workflowVersionId },
      condition: {
        workflowId: conditionWorkflowId,
        workflowVersionId: conditionWorkflowVersionId,
      },
      forEach: {
        workflowId: forEachWorkflowId,
        workflowVersionId: forEachWorkflowVersionId,
      },
      nestedParallel: {
        workflowId: nestedParallelWorkflowId,
        workflowVersionId: nestedParallelWorkflowVersionId,
      },
      parallel: {
        workflowId: parallelWorkflowId,
        workflowVersionId: parallelWorkflowVersionId,
      },
      switch: {
        workflowId: switchWorkflowId,
        workflowVersionId: switchWorkflowVersionId,
      },
      wait: {
        workflowId: waitWorkflowId,
        workflowVersionId: waitWorkflowVersionId,
      },
    });
    await clearOwnedQueue(QUEUE_NAME.workflowCoordinator);
    await clearOwnedQueue(QUEUE_NAME.nodeAttempts);
  } catch (setupError: unknown) {
    let cleanupError: unknown;
    await cleanupFixture().catch((error: unknown) => {
      cleanupError = error;
    });
    if (cleanupError === undefined) throw setupError;
    throw new AggregateError(
      [setupError, cleanupError],
      'Coordinator fixture setup failed',
    );
  }
}

async function clearOwnedQueue(queueName: string): Promise<void> {
  const queue = new Queue(queueName, { connection: redisConnection() });
  let operationError: unknown;
  await queue.obliterate({ force: true }).catch((error: unknown) => {
    operationError = error;
  });
  await queue.close().catch((error: unknown) => {
    operationError =
      operationError === undefined
        ? error
        : new AggregateError(
            [operationError, error],
            `Coordinator ${queueName} cleanup failed`,
          );
  });
  if (operationError !== undefined)
    throw operationError instanceof Error
      ? operationError
      : new Error(`Coordinator ${queueName} cleanup failed`, {
          cause: operationError,
        });
}

function cleanupFixture(): Promise<void> {
  cleanupPromise ??= (async () => {
    const errors: unknown[] = [];
    const attempt = async (
      label: string,
      operation: () => void | Promise<void>,
    ): Promise<void> => {
      await Promise.resolve()
        .then(operation)
        .catch((cause: unknown) => {
          errors.push(
            new Error(`Coordinator fixture cleanup failed: ${label}`, {
              cause,
            }),
          );
        });
    };
    if (redisNamespaceAcquired) {
      await attempt('workflow coordinator queue', () =>
        clearOwnedQueue(QUEUE_NAME.workflowCoordinator),
      );
      await attempt('node attempts queue', () =>
        clearOwnedQueue(QUEUE_NAME.nodeAttempts),
      );
    }
    if (apiDatabaseCreated) {
      await attempt('API database', () => apiDatabase.close());
      apiDatabaseCreated = false;
    }
    if (workerPoolCreated) {
      await attempt('worker pool', () => workerPool.end());
      workerPoolCreated = false;
    }
    if (ownerPoolCreated) {
      await attempt('owner pool', () => ownerPool.end());
      ownerPoolCreated = false;
    }
    if (redisNamespaceAcquired) {
      await attempt('Redis namespace', () => redisNamespace.close());
      redisNamespaceAcquired = false;
    }
    await attempt('disposable database', dropDatabase);
    if (errors.length > 0)
      throw new AggregateError(errors, 'Coordinator fixture cleanup failed');
  })();
  return cleanupPromise;
}

async function restoreServicesAndCleanupFixture(): Promise<void> {
  const errors: unknown[] = [];
  await restoreServices().catch((error: unknown) => errors.push(error));
  await cleanupFixture().catch((error: unknown) => errors.push(error));
  if (errors.length > 0)
    throw new AggregateError(
      errors,
      'Coordinator service restoration or fixture cleanup failed',
    );
}

export interface CoordinatorIntegrationFixture {
  readonly actorId: string;
  readonly adminUrl: string;
  readonly apiDatabase: ReturnType<typeof createWorkspaceDatabase>;
  readonly apiQuery: typeof apiQuery;
  readonly apiUrl: string;
  readonly conditionWorkflowId: string;
  readonly conditionWorkflowVersionId: string;
  readonly databaseUrl: typeof databaseUrl;
  readonly dispatcherUrl: string;
  readonly enabled: boolean;
  readonly forEachWorkflowId: string;
  readonly forEachWorkflowVersionId: string;
  readonly nestedParallelWorkflowId: string;
  readonly nestedParallelWorkflowVersionId: string;
  readonly ownerPool: Pool;
  readonly ownerQuery: typeof ownerQuery;
  readonly parallelWorkflowId: string;
  readonly parallelWorkflowVersionId: string;
  readonly redisConnection: typeof redisConnection;
  readonly redisUrl: string;
  readonly restoreServicesAndClose: typeof restoreServicesAndCleanupFixture;
  readonly setup: typeof setupFixture;
  readonly startService: typeof startService;
  readonly stopService: typeof stopService;
  readonly switchWorkflowId: string;
  readonly switchWorkflowVersionId: string;
  readonly waitFor: typeof waitFor;
  readonly waitWorkflowId: string;
  readonly waitWorkflowVersionId: string;
  readonly workerPool: Pool;
  readonly workerQuery: typeof workerQuery;
  readonly workerUrl: string;
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly workspaceId: string;
}

export const coordinatorFixture: CoordinatorIntegrationFixture = Object.freeze({
  actorId,
  adminUrl,
  get apiDatabase() {
    if (!apiDatabaseCreated)
      throw new Error('Coordinator API database is not initialized');
    return apiDatabase;
  },
  apiQuery,
  apiUrl,
  conditionWorkflowId,
  conditionWorkflowVersionId,
  databaseUrl,
  dispatcherUrl,
  enabled,
  forEachWorkflowId,
  forEachWorkflowVersionId,
  nestedParallelWorkflowId,
  nestedParallelWorkflowVersionId,
  get ownerPool() {
    if (!ownerPoolCreated)
      throw new Error('Coordinator owner pool is not initialized');
    return ownerPool;
  },
  ownerQuery,
  parallelWorkflowId,
  parallelWorkflowVersionId,
  redisConnection,
  redisUrl,
  restoreServicesAndClose: restoreServicesAndCleanupFixture,
  setup: setupFixture,
  startService,
  stopService,
  switchWorkflowId,
  switchWorkflowVersionId,
  waitFor,
  waitWorkflowId,
  waitWorkflowVersionId,
  get workerPool() {
    if (!workerPoolCreated)
      throw new Error('Coordinator worker pool is not initialized');
    return workerPool;
  },
  workerQuery,
  workerUrl,
  workflowId,
  workflowVersionId,
  workspaceId,
});
