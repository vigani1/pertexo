import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  canonicalOutboxPayloadChecksum,
  createOutboxDispatcherDatabase,
  createWorkspaceDatabase,
  insertOutboxEvent,
  migrateDatabase,
  parseDatabaseConfig,
  parseMigrationConfig,
} from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';
import type { QueueProducer } from '@pertexo/queue';
import type { Queue } from 'bullmq';
import { Pool } from 'pg';
import { describe, expect } from 'vitest';
import { z } from 'zod';
import type { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../src/transport/outbox/dispatch/runtime.js';
import { createDockerComposeServiceController } from '../../support/infrastructure/compose-service-control.js';
import { dropDisconnectedDatabase } from '../../support/infrastructure/disposable-database.js';
import { createRedisTestNamespace } from '../../support/infrastructure/redis-test-namespace.js';

const execFileAsync = promisify(execFile);

const enabled = process.env.WORKER_TRANSPORT_RESILIENCE === 'true';

export const describeResilience = enabled ? describe : describe.skip;

const repositoryRoot = fileURLToPath(
  new URL('../../../../../', import.meta.url),
);

export const REDIS_PROOF_DATABASE = 15;

const SERVICE_OPERATION_TIMEOUT_MS = 120_000;

const PROOF_OPERATION_TIMEOUT_MS = 10_000;

const serviceController = createDockerComposeServiceController({
  cwd: repositoryRoot,
  operationTimeoutMillis: SERVICE_OPERATION_TIMEOUT_MS,
});

type StoppedService = Awaited<ReturnType<typeof serviceController.stop>>;

const stoppedServices = new Map<'postgres' | 'redis', StoppedService>();

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@127.0.0.1:5432/pertexo';

const apiUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@127.0.0.1:5432/pertexo';

const dispatcherUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@127.0.0.1:5432/pertexo';

const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@127.0.0.1:6379/0';

const redisPassword = process.env.REDIS_PASSWORD ?? 'pertexo-local-redis';

const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@127.0.0.1:5432/postgres';

const databaseName = `pertexo_test_transport_resilience_${randomUUID().replaceAll('-', '')}`;

interface OutboxProofState {
  readonly failed_at: Date | null;
  readonly last_error_code: string | null;
  readonly lease_expires_at: Date | null;
  readonly lease_owner: string | null;
  readonly publish_attempts: number;
  readonly published_at: Date | null;
}

export interface ProofMeasurements {
  bullmqVersion?: string;
  drainCloseMs?: number;
  drainNoNewClaimAttempts?: number;
  forcedConsumerCloseMs?: number;
  migrationHead?: string;
  postgresFailureDetectionMs?: number;
  postgresRecoveredPublishAttempts?: number;
  postgresRecoveryMs?: number;
  postgresVersion?: string;
  queueLossRecoveredPublishAttempts?: number;
  queueLossRecoveryMs?: number;
  redisFailureDetectionMs?: number;
  redisRestartRetainedJobs?: number;
  redisUnavailableBacklog?: number;
  redisUnavailableLeaseReleased?: boolean;
  redisUnavailablePublishAttempts?: number;
  redisRecoveredPublishAttempts?: number;
  redisRecoveryMs?: number;
  redisVersion?: string;
}

function localUrl(
  value: string,
  label: string,
  protocol: 'postgresql:' | 'redis:',
): URL {
  const parsed = new URL(value);
  if (
    !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
    parsed.protocol !== protocol
  ) {
    throw new Error(
      `${label} must target a local generated Compose dependency`,
    );
  }
  return parsed;
}

const localAdminUrl = localUrl(adminUrl, 'DATABASE_ADMIN_URL', 'postgresql:');

const localMigrationBaseUrl = localUrl(
  migrationUrl,
  'DATABASE_MIGRATION_URL',
  'postgresql:',
);

const localApiBaseUrl = localUrl(apiUrl, 'DATABASE_URL', 'postgresql:');

const localDispatcherBaseUrl = localUrl(
  dispatcherUrl,
  'DATABASE_MAINTENANCE_URL',
  'postgresql:',
);

function disposableDatabaseUrl(baseUrl: URL): URL {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed;
}

const localMigrationUrl = disposableDatabaseUrl(localMigrationBaseUrl);

const localApiUrl = disposableDatabaseUrl(localApiBaseUrl);

const localDispatcherUrl = disposableDatabaseUrl(localDispatcherBaseUrl);

export const redisNamespace = createRedisTestNamespace(
  localUrl(configuredRedisUrl, 'REDIS_URL', 'redis:').toString(),
  REDIS_PROOF_DATABASE,
  'transport-resilience',
);

export const redisUrl = redisNamespace.redisUrl;

export function redisConnection(): {
  db: number;
  host: string;
  password?: string;
  port: number;
} {
  const parsed = new URL(redisUrl);
  return {
    db: REDIS_PROOF_DATABASE,
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password === ''
      ? {}
      : { password: decodeURIComponent(parsed.password) }),
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

let proofDatabaseCreated = false;

export async function createProofDatabase(): Promise<void> {
  const admin = new Pool({
    connectionString: localAdminUrl.toString(),
    max: 1,
  });
  let operationError: unknown;
  try {
    await admin.query(
      `create database ${quoteIdentifier(databaseName)} owner ${quoteIdentifier(ownerRole)}`,
    );
    proofDatabaseCreated = true;
    await admin.query(
      `revoke all on database ${quoteIdentifier(databaseName)} from public`,
    );
    await admin.query(
      `grant connect on database ${quoteIdentifier(databaseName)} to ${[
        process.env.POSTGRES_MIGRATION_USER ?? 'pertexo_migration',
        process.env.POSTGRES_APP_USER ?? 'pertexo_app',
        process.env.POSTGRES_MAINTENANCE_USER ?? 'pertexo_maintenance',
      ]
        .map(quoteIdentifier)
        .join(',')}`,
    );
  } catch (error: unknown) {
    operationError = error;
  }
  await admin.end().catch((error: unknown) => {
    operationError =
      operationError === undefined
        ? error
        : new AggregateError(
            [operationError, error],
            'Transport resilience database setup failed',
          );
  });
  if (operationError !== undefined)
    throw operationError instanceof Error
      ? operationError
      : new Error('Transport resilience database setup failed', {
          cause: operationError,
        });
  await migrateDatabase(
    parseMigrationConfig({
      ...process.env,
      DATABASE_MIGRATION_URL: localMigrationUrl.toString(),
      NODE_ENV: 'test',
    }),
  );
}

export async function dropProofDatabase(): Promise<void> {
  if (!proofDatabaseCreated) return;
  const admin = new Pool({
    connectionString: localAdminUrl.toString(),
    max: 1,
  });
  let operationError: unknown;
  await dropDisconnectedDatabase(admin, databaseName)
    .then(() => {
      proofDatabaseCreated = false;
    })
    .catch((error: unknown) => {
      operationError = error;
    });
  await admin.end().catch((error: unknown) => {
    operationError =
      operationError === undefined
        ? error
        : new AggregateError(
            [operationError, error],
            'Transport resilience database cleanup failed',
          );
  });
  if (operationError !== undefined)
    throw operationError instanceof Error
      ? operationError
      : new Error('Transport resilience database cleanup failed', {
          cause: operationError,
        });
}

async function compose(...arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync('docker', ['compose', ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: SERVICE_OPERATION_TIMEOUT_MS,
  });
  return result.stdout.trim();
}

export async function restoreServices(): Promise<void> {
  const errors: unknown[] = [];
  for (const [service, stopped] of [...stoppedServices])
    await serviceController
      .start(stopped)
      .then(() => stoppedServices.delete(service))
      .catch((error: unknown) => errors.push(error));
  if (errors.length > 0)
    throw new AggregateError(
      errors,
      'Transport resilience service restore failed',
    );
}

export async function stopProofService(
  service: 'postgres' | 'redis',
): Promise<StoppedService> {
  if (stoppedServices.has(service))
    throw new Error(
      `Compose service ${service} is already stopped by this proof`,
    );
  const stopped = await serviceController.stop(service);
  stoppedServices.set(service, stopped);
  return stopped;
}

export async function startProofService(
  stopped: StoppedService,
): Promise<number> {
  const duration = await serviceController.start(stopped);
  stoppedServices.delete(stopped.service);
  return duration;
}

export async function flushProofRedis(): Promise<void> {
  const response = await compose(
    'exec',
    '-T',
    'redis',
    'redis-cli',
    '--raw',
    '--no-auth-warning',
    '-a',
    redisPassword,
    '-n',
    String(REDIS_PROOF_DATABASE),
    'FLUSHDB',
  );
  if (response !== 'OK') {
    throw new Error('Redis proof database did not acknowledge FLUSHDB');
  }
}

export async function withDeadline<T>(
  operation: Promise<T>,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} exceeded its proof deadline`));
    }, PROOF_OPERATION_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(
          error instanceof Error
            ? error
            : new Error(`${label} failed`, { cause: error }),
        );
      },
    );
  });
}

function dispatcherPool(): Pool {
  const pool = new Pool({
    connectionString: localDispatcherUrl.toString(),
    connectionTimeoutMillis: 1_000,
    max: 1,
  });
  pool.on('error', () => undefined);
  return pool;
}

export async function insertProofEvent(
  workspaceId: string,
  id: string,
): Promise<void> {
  const database = createWorkspaceDatabase(
    parseDatabaseConfig({
      connectionString: localApiUrl.toString(),
      connectionTimeoutMillis: 1_000,
      max: 1,
    }),
  );
  const notificationIntentId = randomUUID();
  const payload = { notificationIntentId };
  try {
    await database.withWorkspace(workspaceId, async (transaction) => {
      await insertOutboxEvent(transaction, {
        aggregateId: notificationIntentId,
        aggregateType: 'run-failure-notification',
        // The dispatcher is intentionally cross-workspace, but this disposable
        // database contains only proof-owned rows.
        availableAt: new Date('1900-01-01T00:00:00.000Z'),
        id,
        jobName: JOB_NAME.deliverRunFailureNotification,
        payload,
        payloadChecksum: canonicalOutboxPayloadChecksum(payload),
      });
    });
  } finally {
    await database.close();
  }
}

export async function outboxState(id: string): Promise<OutboxProofState> {
  const pool = dispatcherPool();
  try {
    const result = await pool.query<OutboxProofState>(
      `
        select
          failed_at,
          last_error_code,
          lease_expires_at,
          lease_owner,
          publish_attempts,
          published_at
        from app.outbox_events
        where id = $1
      `,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`Missing proof outbox event ${id}`);
    }
    return row;
  } finally {
    await pool.end();
  }
}

export async function assertCleanOutbox(workspaceId: string): Promise<void> {
  const pool = dispatcherPool();
  try {
    const result = await pool.query<{ pending: number }>(
      `
        select count(*)::integer as pending
        from app.outbox_events
        where workspace_id = $1
          and published_at is null
          and failed_at is null
      `,
      [workspaceId],
    );
    expect(result.rows[0]).toEqual({ pending: 0 });
  } finally {
    await pool.end();
  }
}

export function createDispatcher(
  drainState: WorkerDrainState,
  leaseOwner: string,
): Readonly<{
  database: ReturnType<typeof createOutboxDispatcherDatabase>;
  dispatcher: OutboxDispatcher;
  producer: QueueProducer;
}> {
  const database = createOutboxDispatcherDatabase(
    parseDatabaseConfig({
      connectionString: localDispatcherUrl.toString(),
      connectionTimeoutMillis: 500,
      max: 1,
    }),
  );
  const producer = createQueueProducer({
    publishTimeoutMs: 500,
    readyTimeoutMs: 500,
    redisUrl,
  });
  return {
    database,
    dispatcher: new OutboxDispatcher(database, producer, {
      drainState: drainState,
      options: {
        batchSize: 100,
        jobNames: [JOB_NAME.deliverRunFailureNotification],
        leaseDurationMillis: 1_000,
        leaseOwner,
        maxAttempts: 5,
        operationTimeoutMillis: 1_000,
        pollIntervalMillis: 25,
        retryDelayMillis: 100,
      },
    }),
    producer,
  };
}

export async function waitForJob(
  queue: Queue,
  outboxId: string,
): Promise<void> {
  const expectedJobId = `outbox-${outboxId}`;
  const deadline = Date.now() + PROOF_OPERATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await queue.getJob(expectedJobId)) !== undefined) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 20);
      timer.unref();
    });
  }
  throw new Error(`queue job ${expectedJobId} exceeded its proof deadline`);
}

export async function dependencyEvidence(
  measurements: ProofMeasurements,
): Promise<void> {
  const pool = dispatcherPool();
  try {
    const result = await pool.query<{
      migration_head: string;
      postgres_version: string;
    }>(`
      select
        current_setting('server_version') as postgres_version,
        (
          select name
          from pertexo_internal.schema_migrations
          order by name desc
          limit 1
        ) as migration_head
    `);
    const row = result.rows[0];
    if (row === undefined) throw new Error('Missing dependency evidence');
    measurements.migrationHead = row.migration_head;
    measurements.postgresVersion = row.postgres_version;
  } finally {
    await pool.end();
  }

  measurements.redisVersion = await compose(
    'exec',
    '-T',
    'redis',
    'redis-server',
    '--version',
  );
  const workerPackage = z
    .object({ devDependencies: z.object({ bullmq: z.string().min(1) }) })
    .parse(
      JSON.parse(
        await readFile(
          new URL('../../../package.json', import.meta.url),
          'utf8',
        ),
      ),
    );
  measurements.bullmqVersion = workerPackage.devDependencies.bullmq;
}
