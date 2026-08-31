import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  canonicalOutboxPayloadChecksum,
  createOutboxDispatcherDatabase,
  createWorkspaceDatabase,
  EXPECTED_MIGRATION_HEAD,
  insertOutboxEvent,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import {
  createQueueConsumer,
  createQueueProducer,
  JOB_NAME,
  parseQueueJob,
  QUEUE_NAME,
} from '@pertexo/queue';
import type { QueueConsumer, QueueProducer } from '@pertexo/queue';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';
import { createDispatchConsumerCapabilityRegistry } from '../src/transport/dispatch-consumer-capabilities.js';
import { OutboxDispatcher } from '../src/transport/outbox-dispatcher.js';

const execFileAsync = promisify(execFile);
const enabled = process.env.WORKER_TRANSPORT_RESILIENCE === 'true';
const describeResilience = enabled ? describe : describe.skip;
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const REDIS_PROOF_DATABASE = 15;
const SERVICE_OPERATION_TIMEOUT_MS = 120_000;
const PROOF_OPERATION_TIMEOUT_MS = 10_000;

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@127.0.0.1:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@127.0.0.1:5432/pertexo';
const dispatcherUrl =
  process.env.DATABASE_DISPATCHER_URL ??
  'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@127.0.0.1:5432/pertexo';
const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@127.0.0.1:6379/0';
const redisPassword = process.env.REDIS_PASSWORD ?? 'pertexo-local-redis';
const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';

interface OutboxProofState {
  readonly failed_at: Date | null;
  readonly last_error_code: string | null;
  readonly lease_expires_at: Date | null;
  readonly lease_owner: string | null;
  readonly publish_attempts: number;
  readonly published_at: Date | null;
}

interface ProofMeasurements {
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

const localMigrationUrl = localUrl(
  migrationUrl,
  'DATABASE_MIGRATION_URL',
  'postgresql:',
);
const localApiUrl = localUrl(apiUrl, 'DATABASE_API_URL', 'postgresql:');
const localDispatcherUrl = localUrl(
  dispatcherUrl,
  'DATABASE_DISPATCHER_URL',
  'postgresql:',
);
const redisUrl = (() => {
  const parsed = localUrl(configuredRedisUrl, 'REDIS_URL', 'redis:');
  parsed.pathname = `/${String(REDIS_PROOF_DATABASE)}`;
  return parsed.toString();
})();

function redisConnection(): {
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

async function compose(...arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync('docker', ['compose', ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: SERVICE_OPERATION_TIMEOUT_MS,
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

async function flushProofRedis(): Promise<void> {
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

async function withDeadline<T>(
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

function migrationPool(): Pool {
  const pool = new Pool({
    connectionString: localMigrationUrl.toString(),
    connectionTimeoutMillis: 1_000,
    max: 1,
  });
  pool.on('error', () => undefined);
  return pool;
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

async function insertProofEvent(
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
  const artifactId = randomUUID();
  const payload = { artifactId };
  try {
    await database.withWorkspace(workspaceId, async (transaction) => {
      await insertOutboxEvent(transaction, {
        aggregateId: artifactId,
        aggregateType: 'artifact',
        // The dispatcher is intentionally cross-workspace. Make this proof row
        // deterministically earlier than unrelated local development rows so
        // a bounded global claim always includes the row under test.
        availableAt: new Date('1900-01-01T00:00:00.000Z'),
        id,
        jobName: JOB_NAME.expireArtifacts,
        payload,
        payloadChecksum: canonicalOutboxPayloadChecksum(payload),
        schemaVersion: 1,
      });
    });
  } finally {
    await database.close();
  }
}

async function outboxState(id: string): Promise<OutboxProofState> {
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

async function assertCleanOutbox(workspaceId: string): Promise<void> {
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

async function cleanupWorkspace(workspaceId: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/u.test(ownerRole)) {
    throw new Error('POSTGRES_OWNER_USER is not a safe SQL identifier');
  }
  const pool = migrationPool();
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role "${ownerRole}"`);
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await client.query(
      'delete from app.outbox_events where workspace_id = $1',
      [workspaceId],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function createDispatcher(
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
  const consumerCapabilities = createDispatchConsumerCapabilityRegistry([
    {
      consumer: {
        isReady: () => true,
        waitUntilReady: () => Promise.resolve(),
      },
      jobName: JOB_NAME.expireArtifacts,
    },
  ]);
  return {
    database,
    dispatcher: new OutboxDispatcher(
      database,
      producer,
      drainState,
      {
        batchSize: 100,
        enabledJobNames: [JOB_NAME.expireArtifacts],
        leaseDurationMillis: 1_000,
        leaseOwner,
        maxAttempts: 5,
        operationTimeoutMillis: 1_000,
        pollIntervalMillis: 25,
        retryDelayMillis: 100,
      },
      undefined,
      consumerCapabilities,
    ),
    producer,
  };
}

async function waitForJob(queue: Queue, outboxId: string): Promise<void> {
  const expectedJobId = `outbox-${outboxId}`;
  await withDeadline(
    (async () => {
      while ((await queue.getJob(expectedJobId)) === undefined) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
      }
    })(),
    `queue job ${expectedJobId}`,
  );
}

async function dependencyEvidence(
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
        await readFile(new URL('../package.json', import.meta.url), 'utf8'),
      ),
    );
  measurements.bullmqVersion = workerPackage.devDependencies.bullmq;
}

describeResilience(
  'worker transport service-loss resilience proof',
  { concurrent: false },
  () => {
    it('recovers PostgreSQL authority across Redis, queue, and PostgreSQL loss while draining safely', async () => {
      const workspaceId = randomUUID();
      const queueLossEventId = randomUUID();
      const redisLossEventId = randomUUID();
      const postgresLossEventId = randomUUID();
      const drainEventId = randomUUID();
      const consumerEventId = randomUUID();
      const measurements: ProofMeasurements = {};
      let queue: Queue | undefined;
      let redisDispatcher: OutboxDispatcher | undefined;
      let postgresDispatcher: OutboxDispatcher | undefined;
      let drainedDispatcher: OutboxDispatcher | undefined;
      let consumer: QueueConsumer | undefined;
      let consumerProducer: QueueProducer | undefined;

      try {
        await restoreServices();
        await flushProofRedis();
        await assertCleanOutbox(workspaceId);
        await dependencyEvidence(measurements);
        expect(measurements.migrationHead).toBe(EXPECTED_MIGRATION_HEAD);

        queue = new Queue(QUEUE_NAME.maintenance, {
          connection: redisConnection(),
        });
        await queue.waitUntilReady();

        const redisBoundaries = createDispatcher(
          new WorkerDrainState(),
          'resilience-redis',
        );
        redisDispatcher = redisBoundaries.dispatcher;
        await redisDispatcher.checkReadiness();

        // Failure point: enqueue succeeds, the dispatcher has not marked the
        // PostgreSQL outbox row, and every Redis key is then lost.
        await insertProofEvent(workspaceId, queueLossEventId);
        const claimed = await redisBoundaries.database.claimBatch({
          enabledJobNames: [JOB_NAME.expireArtifacts],
          leaseDurationMillis: 1_000,
          leaseOwner: 'resilience-crashed',
          leaseToken: randomUUID(),
          limit: 1,
          maxAttempts: 5,
        });
        expect(claimed.events).toHaveLength(1);
        const leased = claimed.events[0];
        if (leased === undefined) throw new Error('Outbox claim disappeared');
        await redisBoundaries.producer.publish(
          parseQueueJob({
            name: leased.jobName,
            data: {
              ...(typeof leased.payload === 'object' &&
              leased.payload !== null &&
              !Array.isArray(leased.payload)
                ? leased.payload
                : {}),
              outboxEventId: leased.id,
              schemaVersion: leased.schemaVersion,
              workspaceId: leased.workspaceId,
            },
          }),
        );
        await waitForJob(queue, queueLossEventId);
        await flushProofRedis();
        expect(
          await queue.getJob(`outbox-${queueLossEventId}`),
        ).toBeUndefined();

        const queueRecoveryStartedAt = performance.now();
        await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
        await redisDispatcher.dispatchOnce();
        await waitForJob(queue, queueLossEventId);
        measurements.queueLossRecoveryMs =
          performance.now() - queueRecoveryStartedAt;
        const queueRecovered = await outboxState(queueLossEventId);
        measurements.queueLossRecoveredPublishAttempts =
          queueRecovered.publish_attempts;
        expect(queueRecovered.publish_attempts).toBe(2);
        expect(queueRecovered.published_at).toBeInstanceOf(Date);

        // Failure point: Redis is fully stopped while a durable outbox row is
        // waiting. Publishing fails closed and releases the PostgreSQL lease.
        await insertProofEvent(workspaceId, redisLossEventId);
        await stopService('redis');
        const redisDetectionStartedAt = performance.now();
        await expect(redisDispatcher.checkReadiness()).rejects.toThrow();
        measurements.redisFailureDetectionMs =
          performance.now() - redisDetectionStartedAt;
        await expect(redisDispatcher.dispatchOnce()).resolves.toEqual({
          claimed: 1,
          failed: 1,
          published: 0,
          stale: 0,
        });
        const redisUnavailable = await outboxState(redisLossEventId);
        measurements.redisUnavailableBacklog =
          redisUnavailable.published_at === null &&
          redisUnavailable.failed_at === null
            ? 1
            : 0;
        measurements.redisUnavailableLeaseReleased =
          redisUnavailable.lease_owner === null &&
          redisUnavailable.lease_expires_at === null;
        measurements.redisUnavailablePublishAttempts =
          redisUnavailable.publish_attempts;
        expect(redisUnavailable).toMatchObject({
          failed_at: null,
          last_error_code: 'queue.publish_failed',
          lease_expires_at: null,
          lease_owner: null,
          publish_attempts: 1,
          published_at: null,
        });

        const redisRecoveryStartedAt = performance.now();
        await startService('redis');
        await withDeadline(
          redisDispatcher.checkReadiness(),
          'Redis readiness recovery',
        );
        await waitForJob(queue, queueLossEventId);
        measurements.redisRestartRetainedJobs = 1;
        await redisDispatcher.dispatchOnce();
        await waitForJob(queue, redisLossEventId);
        measurements.redisRecoveryMs =
          performance.now() - redisRecoveryStartedAt;
        const redisRecovered = await outboxState(redisLossEventId);
        measurements.redisRecoveredPublishAttempts =
          redisRecovered.publish_attempts;
        expect(redisRecovered.publish_attempts).toBe(2);
        expect(redisRecovered.published_at).toBeInstanceOf(Date);

        await redisDispatcher.close();
        redisDispatcher = undefined;
        await queue.close();
        queue = undefined;
        await flushProofRedis();

        // Create the authority record while PostgreSQL is healthy, close its
        // serving connection, then start a dispatcher while PostgreSQL is down.
        await insertProofEvent(workspaceId, postgresLossEventId);
        await stopService('postgres');
        const postgresBoundaries = createDispatcher(
          new WorkerDrainState(),
          'resilience-postgres',
        );
        postgresDispatcher = postgresBoundaries.dispatcher;
        const postgresDetectionStartedAt = performance.now();
        await expect(postgresDispatcher.checkReadiness()).rejects.toThrow();
        measurements.postgresFailureDetectionMs =
          performance.now() - postgresDetectionStartedAt;
        await expect(postgresDispatcher.dispatchOnce()).rejects.toThrow();

        queue = new Queue(QUEUE_NAME.maintenance, {
          connection: redisConnection(),
        });
        await queue.waitUntilReady();
        expect(
          await queue.getJob(`outbox-${postgresLossEventId}`),
        ).toBeUndefined();

        const postgresRecoveryStartedAt = performance.now();
        await startService('postgres');
        await withDeadline(
          postgresDispatcher.checkReadiness(),
          'PostgreSQL readiness recovery',
        );
        await postgresDispatcher.dispatchOnce();
        await waitForJob(queue, postgresLossEventId);
        measurements.postgresRecoveryMs =
          performance.now() - postgresRecoveryStartedAt;
        const postgresRecovered = await outboxState(postgresLossEventId);
        measurements.postgresRecoveredPublishAttempts =
          postgresRecovered.publish_attempts;
        expect(postgresRecovered.publish_attempts).toBe(1);
        expect(postgresRecovered.published_at).toBeInstanceOf(Date);

        await postgresDispatcher.close();
        postgresDispatcher = undefined;
        await queue.close();
        queue = undefined;
        await flushProofRedis();

        // Real drain proof: readiness falls before drain, dispatch admits no
        // row, and both dispatcher and an active consumer close within bounds.
        await insertProofEvent(workspaceId, drainEventId);
        const drainState = new WorkerDrainState();
        const drainBoundaries = createDispatcher(
          drainState,
          'resilience-drain',
        );
        drainedDispatcher = drainBoundaries.dispatcher;
        await drainedDispatcher.checkReadiness();
        drainState.beginDrain();
        await expect(drainedDispatcher.checkReadiness()).rejects.toThrow(
          /draining/u,
        );
        await expect(drainedDispatcher.dispatchOnce()).resolves.toEqual({
          claimed: 0,
          failed: 0,
          published: 0,
          stale: 0,
        });
        const drainedOutbox = await outboxState(drainEventId);
        measurements.drainNoNewClaimAttempts = drainedOutbox.publish_attempts;
        expect(drainedOutbox).toMatchObject({
          lease_owner: null,
          publish_attempts: 0,
          published_at: null,
        });
        const drainCloseStartedAt = performance.now();
        await drainedDispatcher.close();
        measurements.drainCloseMs = performance.now() - drainCloseStartedAt;
        expect(measurements.drainCloseMs).toBeLessThan(2_000);
        drainedDispatcher = undefined;

        const handlerStarted = (() => {
          let resolveStarted: (() => void) | undefined;
          const promise = new Promise<void>((resolve) => {
            resolveStarted = resolve;
          });
          return {
            promise,
            resolve: (): void => resolveStarted?.(),
          };
        })();
        consumer = createQueueConsumer({
          drainTimeoutMs: 50,
          handler: async (_delivery, context) => {
            handlerStarted.resolve();
            await new Promise<never>((_resolve, reject) => {
              context.signal.addEventListener(
                'abort',
                () => {
                  reject(
                    context.signal.reason instanceof Error
                      ? context.signal.reason
                      : new Error('Consumer proof aborted'),
                  );
                },
                { once: true },
              );
            });
          },
          queueName: QUEUE_NAME.workflowCoordinator,
          redisUrl,
          timeoutMs: 5_000,
        });
        consumerProducer = createQueueProducer({ redisUrl });
        await Promise.all([
          consumer.waitUntilReady(),
          consumerProducer.waitUntilReady(),
        ]);
        const consumerRunId = randomUUID();
        await consumerProducer.publish({
          name: JOB_NAME.advanceWorkflowRun,
          data: {
            outboxEventId: consumerEventId,
            runId: consumerRunId,
            schemaVersion: 1,
            workspaceId,
          },
        });
        await withDeadline(handlerStarted.promise, 'consumer admission');
        const consumerCloseStartedAt = performance.now();
        const closeResult = await consumer.close();
        measurements.forcedConsumerCloseMs =
          performance.now() - consumerCloseStartedAt;
        expect(closeResult).toEqual({ abortedJobs: 1, forced: true });
        expect(consumer.isReady()).toBe(false);
        expect(measurements.forcedConsumerCloseMs).toBeLessThan(2_000);
        consumer = undefined;

        expect(measurements).toMatchObject({
          bullmqVersion: '6.1.2',
          migrationHead: EXPECTED_MIGRATION_HEAD,
        });
      } finally {
        await restoreServices();
        await Promise.allSettled([
          redisDispatcher?.close() ?? Promise.resolve(),
          postgresDispatcher?.close() ?? Promise.resolve(),
          drainedDispatcher?.close() ?? Promise.resolve(),
          consumer?.close() ?? Promise.resolve(),
          consumerProducer?.close() ?? Promise.resolve(),
          queue?.close() ?? Promise.resolve(),
        ]);
        await flushProofRedis();
        await cleanupWorkspace(workspaceId);
        process.stdout.write(
          `PHASE_0D_RESILIENCE_METRICS ${JSON.stringify({
            ...measurements,
            failureInjectionPoints: [
              'enqueue-before-outbox-mark then Redis DB loss',
              'Redis service stop before outbox dispatch',
              'PostgreSQL service stop before outbox claim',
              'drain before dispatcher claim',
              'drain deadline during active BullMQ handler',
            ],
            redisDatabase: REDIS_PROOF_DATABASE,
          })}\n`,
        );
      }
    });
  },
);
