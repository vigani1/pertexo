import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import {
  canonicalOutboxPayloadChecksum,
  createCompatibilityReleaseMaintenance,
  createCompatibilityReleaseReadinessProbe,
  createDueNodeWakeupScanner,
  createFailureNotificationStore,
  createOutboxDispatcherDatabase,
  createWorkspaceDatabase,
  parseDatabaseConfig,
  requestWorkflowRunCancellation,
} from '@pertexo/database/testing';
import {
  PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED,
  PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_HTTP_STAGED,
  PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_FOR_EACH_STAGED,
  PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_MERGE_STAGED,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED,
  PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED,
} from '@pertexo/node-catalog';
import {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
} from '@pertexo/integrations/server';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import { CORE_REGISTRY_RELEASE_SUCCESSOR } from '@pertexo/nodes-core';
import {
  composeExecutableCompatibilityRelease,
  describeExecutableCompatibilityRelease,
  invocationKey,
  parseCheckpoint,
} from '@pertexo/workflow-engine';
import { createQueueProducer, JOB_NAME, QUEUE_NAME } from '@pertexo/queue';
import { Queue } from 'bullmq';
import { Pool } from 'pg';

import { createCoordinatorRuntime } from '../src/execution/coordinator-runtime.js';
import type { CoordinatorAdvanceEngine } from '../src/execution/coordinator-handler.js';
import { createProviderFailureNotificationDelivery } from '../src/execution/failure-notification-delivery.js';
import { createNodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';
import { createPreviewMaintenanceRuntime } from '../src/execution/preview-maintenance-runtime.js';
import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';
import { createDispatchConsumerCapabilityRegistry } from '../src/transport/dispatch-consumer-capabilities.js';
import { OutboxDispatcher } from '../src/transport/outbox-dispatcher.js';
import { seedCoordinatorWorkflowFixtures } from './support/coordinator-workflow-fixtures.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';
import { queryAsWorkspaceRole } from './support/workspace-query.js';

const enabled = process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
const execFileAsync = promisify(execFile);
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const dispatcherUrl =
  process.env.DATABASE_DISPATCHER_URL ??
  'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo';
const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';
const databaseName = `pertexo_test_retained_core_${randomUUID().replaceAll('-', '')}`;
const repositoryRoot = new URL('../../../', import.meta.url).pathname;

async function compose(...arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync('docker', ['compose', ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return result.stdout.trim();
}

async function stopService(service: 'postgres' | 'redis'): Promise<void> {
  await compose('stop', '--timeout', '10', service);
}

async function startService(service: 'postgres' | 'redis'): Promise<number> {
  const startedAt = performance.now();
  await compose('up', '-d', '--wait', service);
  return performance.now() - startedAt;
}

async function restoreServices(): Promise<void> {
  await compose('up', '-d', '--wait', 'postgres', 'redis');
}

function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const redisUrl = (() => {
  const parsed = new URL(configuredRedisUrl);
  parsed.pathname = '/12';
  return parsed.toString();
})();

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
const engineVersion = 'phase3-engine-v1';
const ownerPool = new Pool({
  connectionString: databaseUrl(migrationUrl),
  max: 1,
});
ownerPool.on('error', () => undefined);
const workerPool = new Pool({
  connectionString: databaseUrl(workerUrl),
  max: 2,
});
workerPool.on('error', () => undefined);
const apiDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: databaseUrl(apiUrl), max: 2 }),
);

async function createDatabase(): Promise<void> {
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await pool.query(`create database "${databaseName}" owner pertexo_owner`);
    await pool.query(`revoke all on database "${databaseName}" from public`);
    await pool.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
    );
  } finally {
    await pool.end();
  }
}

async function migrateDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'pnpm',
      [
        '--filter',
        '@pertexo/database',
        '--fail-if-no-match',
        'exec',
        'tsx',
        'src/migrate.ts',
      ],
      {
        cwd: new URL('../../../', import.meta.url).pathname,
        env: {
          ...process.env,
          DATABASE_MIGRATION_URL: databaseUrl(migrationUrl),
        },
        stdio: 'inherit',
      },
    );
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`retained core migration failed: ${String(code)}`));
    });
  });
}

async function dropDatabase(): Promise<void> {
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(pool, databaseName);
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
): Promise<readonly T[]> {
  const pool = new Pool({
    connectionString: databaseUrl(apiUrl),
    max: 1,
  });
  try {
    await pool.query('begin');
    await pool.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await pool.query<T>(statement, [...parameters]);
    await pool.query('commit');
    return result.rows;
  } catch (error: unknown) {
    await pool.query('rollback').catch(() => undefined);
    throw error;
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

async function activateRelease(
  targetRelease: Parameters<typeof composeExecutableCompatibilityRelease>[0],
): Promise<void> {
  const target = describeExecutableCompatibilityRelease(
    composeExecutableCompatibilityRelease(targetRelease),
  );
  const currentRows = await ownerQuery<{
    catalog_json: unknown;
    epoch: number;
    fingerprint: string;
  }>(
    `select current.epoch,current.fingerprint,release.catalog_json
     from app.node_compatibility_current current
     join app.node_compatibility_releases release
       on release.epoch=current.epoch and release.fingerprint=current.fingerprint`,
  );
  const current = currentRows[0];
  if (current === undefined) throw new Error('compatibility pointer missing');
  const predecessor = {
    catalogJson:
      typeof current.catalog_json === 'string'
        ? current.catalog_json
        : JSON.stringify(current.catalog_json),
    epoch: current.epoch,
    fingerprint: current.fingerprint,
  };
  const supported = [predecessor, target];
  const maintenance = createCompatibilityReleaseMaintenance(
    parseDatabaseConfig({
      connectionString: databaseUrl(migrationUrl),
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    }),
  );
  const apiProbe = createCompatibilityReleaseReadinessProbe(
    parseDatabaseConfig({ connectionString: databaseUrl(apiUrl), max: 1 }),
    supported,
  );
  const workerProbe = createCompatibilityReleaseReadinessProbe(
    parseDatabaseConfig({ connectionString: databaseUrl(workerUrl), max: 1 }),
    supported,
  );
  const epoch = String(target.epoch);
  const deploymentId = `retained-core-${epoch}-${randomUUID()}`;
  const approvalId = randomUUID();
  try {
    await maintenance.prepare({
      actorId: 'retained-core-integration',
      actorKind: 'deployment',
      expectedPredecessor: predecessor,
      reason: 'Prepare retained core execution release',
      target,
    });
    await Promise.all([
      apiProbe.checkTarget(target),
      workerProbe.checkTarget(target),
    ]);
    for (const roleKind of ['api', 'worker'] as const)
      await maintenance.recordPreactivation({
        artifactId: `retained-core-${roleKind}-${epoch}`,
        checkId: randomUUID(),
        deploymentId,
        roleKind,
        target,
      });
    await maintenance.approve({
      actorId: 'retained-core-integration',
      approvalId,
      deploymentId,
      reason: 'Approve retained core execution release',
      requiredApiArtifacts: [`retained-core-api-${epoch}`],
      requiredWorkerArtifacts: [`retained-core-worker-${epoch}`],
      target,
    });
    await maintenance.activate({
      activationId: randomUUID(),
      actorId: 'retained-core-integration',
      actorKind: 'deployment',
      approvalId,
      expectedPredecessor: predecessor,
      reason: 'Activate retained core execution release',
    });
  } finally {
    await Promise.allSettled([
      maintenance.close(),
      apiProbe.close(),
      workerProbe.close(),
    ]);
  }
}

async function setupFixture(): Promise<void> {
  await createDatabase();
  await migrateDatabase();
  await activateRelease(CORE_REGISTRY_RELEASE_SUCCESSOR);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_HTTP_STAGED);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_MERGE_STAGED);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_FOR_EACH_STAGED);
  await activateRelease(PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE);
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
    parallel: {
      workflowId: parallelWorkflowId,
      workflowVersionId: parallelWorkflowVersionId,
    },
    switch: {
      workflowId: switchWorkflowId,
      workflowVersionId: switchWorkflowVersionId,
    },
  });
  const queue = new Queue(QUEUE_NAME.workflowCoordinator, {
    connection: redisConnection(),
  });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
  }
  const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
    connection: redisConnection(),
  });
  try {
    await attemptQueue.obliterate({ force: true });
  } finally {
    await attemptQueue.close();
  }
}

async function cleanupFixture(): Promise<void> {
  const queue = new Queue(QUEUE_NAME.workflowCoordinator, {
    connection: redisConnection(),
  });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
    const attemptQueue = new Queue(QUEUE_NAME.nodeAttempts, {
      connection: redisConnection(),
    });
    try {
      await attemptQueue.obliterate({ force: true });
    } finally {
      await attemptQueue.close();
    }
    await apiDatabase.close();
    await ownerPool.end();
    await workerPool.end();
    await dropDatabase();
  }
}

export {
  CORE_REGISTRY_RELEASE_SUCCESSOR,
  JOB_NAME,
  OutboxDispatcher,
  PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_CONDITION_STAGED,
  PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_FOR_EACH_STAGED,
  PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_HTTP_STAGED,
  PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_MERGE_STAGED,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_PARALLEL_STAGED,
  PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_SWITCH_STAGED,
  Pool,
  QUEUE_NAME,
  Queue,
  SECURE_HTTP_ERROR_CODE,
  SecureHttpError,
  WorkerDrainState,
  activateRelease,
  actorId,
  adminUrl,
  apiDatabase,
  apiQuery,
  apiUrl,
  canonicalOutboxPayloadChecksum,
  cleanupFixture,
  compose,
  composeExecutableCompatibilityRelease,
  conditionWorkflowId,
  conditionWorkflowVersionId,
  configuredRedisUrl,
  createCompatibilityReleaseMaintenance,
  createCompatibilityReleaseReadinessProbe,
  createCoordinatorRuntime,
  createDatabase,
  createDispatchConsumerCapabilityRegistry,
  createDueNodeWakeupScanner,
  createFailureNotificationStore,
  createHash,
  createNodeAttemptRuntime,
  createOutboxDispatcherDatabase,
  createPlatformNodeRegistryForRelease,
  createPreviewMaintenanceRuntime,
  createProviderFailureNotificationDelivery,
  createQueueProducer,
  createWorkspaceDatabase,
  databaseName,
  databaseUrl,
  describeExecutableCompatibilityRelease,
  dispatcherUrl,
  dropDatabase,
  dropDisconnectedDatabase,
  enabled,
  engineVersion,
  execFile,
  execFileAsync,
  forEachWorkflowId,
  forEachWorkflowVersionId,
  invocationKey,
  migrateDatabase,
  migrationUrl,
  ownerPool,
  ownerQuery,
  parallelWorkflowId,
  parallelWorkflowVersionId,
  parseCheckpoint,
  parseDatabaseConfig,
  performance,
  promisify,
  randomUUID,
  redisConnection,
  redisUrl,
  repositoryRoot,
  requestWorkflowRunCancellation,
  restoreServices,
  setupFixture,
  spawn,
  startService,
  stopService,
  switchWorkflowId,
  switchWorkflowVersionId,
  waitFor,
  workerPool,
  workerQuery,
  workerUrl,
  workflowId,
  workflowVersionId,
  workspaceId,
};

export type { ChildProcess, CoordinatorAdvanceEngine };
