import {
  createWorkspaceDatabase,
  migrateDatabase as migrateSchema,
  parseDatabaseConfig,
  parseMigrationConfig,
} from '@pertexo/database/testing';

import { QUEUE_NAME } from '@pertexo/queue';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { seedCoordinatorWorkflowFixtures } from '../workflows.js';
import { dropDisconnectedDatabase } from '../../infrastructure/disposable-database.js';

import { queryAsWorkspaceRole } from '../../workspace-query.js';
import {
  adminUrl,
  migrationUrl,
  apiUrl,
  workerUrl,
  databaseName,
  databaseUrl,
  redisNamespace,
  actorId,
  workspaceId,
  workflowId,
  workflowVersionId,
  conditionWorkflowId,
  conditionWorkflowVersionId,
  switchWorkflowId,
  switchWorkflowVersionId,
  parallelWorkflowId,
  parallelWorkflowVersionId,
  forEachWorkflowId,
  forEachWorkflowVersionId,
  nestedParallelWorkflowId,
  nestedParallelWorkflowVersionId,
  waitWorkflowId,
  waitWorkflowVersionId,
  redisConnection,
} from './environment.js';
import { restoreServices } from './services.js';

export let ownerPool!: Pool;

export let workerPool!: Pool;

export let apiDatabase!: ReturnType<typeof createWorkspaceDatabase>;

export let ownerPoolCreated = false;

export let workerPoolCreated = false;

export let apiDatabaseCreated = false;

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

export async function ownerQuery<T extends Record<string, unknown>>(
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

export async function workerQuery<T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<readonly T[]> {
  return queryAsWorkspaceRole<T>({
    pool: workerPool,
    workspaceId: workspaceId,
    statement: statement,
    parameters: parameters,
  });
}

export async function apiQuery<T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
  manualStart?: Readonly<{ workflowId: string; keyHash: string }>,
): Promise<readonly T[]> {
  const pool = new Pool({
    connectionString: databaseUrl(apiUrl),
    max: 1,
  });
  try {
    return await queryAsWorkspaceRole<T>({
      pool: pool,
      workspaceId: workspaceId,
      statement: statement,
      parameters: parameters,
      manualStart: manualStart,
    });
  } finally {
    await pool.end();
  }
}

export async function setupFixture(): Promise<void> {
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

export async function restoreServicesAndCleanupFixture(): Promise<void> {
  const errors: unknown[] = [];
  await restoreServices().catch((error: unknown) => errors.push(error));
  await cleanupFixture().catch((error: unknown) => errors.push(error));
  if (errors.length > 0)
    throw new AggregateError(
      errors,
      'Coordinator service restoration or fixture cleanup failed',
    );
}
