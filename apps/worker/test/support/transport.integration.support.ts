import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  canonicalOutboxPayloadChecksum,
  createOutboxDispatcherDatabase,
  createWorkspaceDatabase,
  insertOutboxEvent,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME, QUEUE_NAME } from '@pertexo/queue';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { WorkerDrainState } from '../../src/runtime/worker-drain-state.js';
import {
  createDispatchConsumerCapabilityRegistry,
  type DispatchConsumerCapabilityRegistry,
} from '../../src/transport/dispatch-consumer-capabilities.js';
import { OutboxDispatcher } from '../../src/transport/outbox-dispatcher.js';

export function createWorkerTransportTestEnvironment() {
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
  const redisUrl =
    process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';

  const workspaceId = '00000000-0000-4000-8000-0000000000d4';
  const actorId = '00000000-0000-4000-8000-0000000000a4';
  const apiDatabase = createWorkspaceDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  );
  const workerDatabase = createWorkspaceDatabase(
    parseDatabaseConfig({ connectionString: workerUrl, max: 4 }),
  );
  const proofIds = new Set<string>();

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
    const client = await pool.connect();
    try {
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
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
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
    await apiDatabase.withWorkspace(workspaceId, async (transaction) => {
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
    });
    return id;
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
    promise: Promise<void>;
    resolve(): void;
  }> => {
    let resolvePromise: (() => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        reject(new Error(`Worker transport stage timed out: ${stage}`));
      }, timeoutMillis);
      timer.unref();
    });
    return {
      promise,
      resolve: () => resolvePromise?.(),
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
    const client = await pool.connect();
    try {
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
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  };

  const close = async (): Promise<void> => {
    const pool = new Pool({ connectionString: migrationUrl, max: 1 });
    const client = await pool.connect();
    let discovered: Readonly<{ rows: readonly { id: string }[] }>;
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      discovered = await client.query<{ id: string }>(
        'select id from app.outbox_events where workspace_id = $1',
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
    for (const { id } of discovered.rows) proofIds.add(id);
    const queues = [...new Set(Object.values(QUEUE_NAME))].map(
      (queueName) =>
        new Queue(queueName, {
          connection: redisConnection(),
        }),
    );
    try {
      for (const queue of queues) {
        for (const id of proofIds) {
          await bounded(
            `remove ${queue.name}/outbox-${id}`,
            queue.getJob(`outbox-${id}`).then((job) => job?.remove()),
          );
        }
      }
      const residualJobs: string[] = [];
      for (const queue of queues) {
        for (const id of proofIds) {
          const jobId = `outbox-${id}`;
          if (
            (await bounded(
              `verify removal ${queue.name}/${jobId}`,
              queue.getJob(jobId),
            )) !== undefined
          ) {
            residualJobs.push(`${queue.name}/${jobId}`);
          }
        }
      }
      if (residualJobs.length > 0) {
        throw new Error(
          `Worker transport cleanup left Bull jobs: ${residualJobs.join(', ')}`,
        );
      }
      await bounded('database cleanup', cleanup());
    } finally {
      await Promise.all([
        ...queues.map((queue) => queue.close()),
        apiDatabase.close(),
        workerDatabase.close(),
      ]);
    }
  };

  return {
    apiDatabase,
    bounded,
    checksum,
    close,
    createDispatcher,
    deferred,
    dispatcherUrl,
    initialize: applyLedgerFixture,
    insertRunEvent,
    redisConnection,
    redisUrl,
    workerDatabase,
    workspaceId,
  };
}
