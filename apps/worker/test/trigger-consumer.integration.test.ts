import { randomUUID } from 'node:crypto';

import type {
  PublishedWorkflowReader,
  ScheduleTriggerScanner,
  WorkflowTriggerReconciliationDatabase,
} from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME, QUEUE_NAME } from '@pertexo/queue';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/unbound-method -- assertions target injected seam fakes */

import { createTriggerRuntime } from '../src/triggers/trigger-runtime.js';
import { createRedisTestNamespace } from './support/redis-test-namespace.js';
import { runWithCleanup } from './support/test-operation.js';

const enabled = process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
const describeIntegration = enabled ? describe : describe.skip;
const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';
function bullConnection(redisUrl: string) {
  const parsed = new URL(redisUrl);
  return {
    db: Number(parsed.pathname.slice(1)),
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password === ''
      ? {}
      : { password: decodeURIComponent(parsed.password) }),
  };
}

describeIntegration('trigger lifecycle BullMQ consumer', () => {
  let queue: Queue | undefined;
  let redisNamespace: ReturnType<typeof createRedisTestNamespace> | undefined;

  const requireQueue = (): Queue => {
    if (queue === undefined)
      throw new Error('Trigger consumer integration queue is not initialized');
    return queue;
  };

  const requireRedisUrl = (): string => {
    if (redisNamespace === undefined)
      throw new Error('Trigger consumer Redis namespace is not initialized');
    return redisNamespace.redisUrl;
  };

  beforeAll(async () => {
    redisNamespace = createRedisTestNamespace(
      configuredRedisUrl,
      14,
      'trigger-consumer',
    );
    try {
      await redisNamespace.acquire();
      queue = new Queue(QUEUE_NAME.triggerLifecycle, {
        connection: bullConnection(redisNamespace.redisUrl),
      });
      await queue.obliterate({ force: true });
    } catch (setupError: unknown) {
      const cleanupErrors: unknown[] = [];
      await queue?.close().catch((error: unknown) => cleanupErrors.push(error));
      await redisNamespace
        .close()
        .catch((error: unknown) => cleanupErrors.push(error));
      if (cleanupErrors.length === 0) throw setupError;
      throw new AggregateError(
        [setupError, ...cleanupErrors],
        'Trigger consumer integration setup failed',
      );
    }
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    await queue
      ?.obliterate({ force: true })
      .catch((error: unknown) => errors.push(error));
    await queue?.close().catch((error: unknown) => errors.push(error));
    await redisNamespace?.close().catch((error: unknown) => errors.push(error));
    if (errors.length > 0)
      throw new AggregateError(
        errors,
        'Trigger consumer integration cleanup failed',
      );
  });

  it('redelivers a transient reconciliation failure through BullMQ and completes the target job', async () => {
    const workspaceId = randomUUID();
    const workflowId = randomUUID();
    const publishedVersionId = randomUUID();
    const outboxEventId = randomUUID();
    const reconciliation: WorkflowTriggerReconciliationDatabase = {
      close: vi.fn().mockResolvedValue(undefined),
      reconcile: vi
        .fn()
        .mockRejectedValueOnce(new Error('transient PostgreSQL outage'))
        .mockResolvedValue([]),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    };
    const reader: PublishedWorkflowReader = {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution: vi.fn().mockResolvedValue({
        kind: 'v2_projection',
        workflowVersion: {
          id: publishedVersionId,
          workspaceId,
          workflowId,
          versionNumber: 1,
          schemaVersion: 1,
          checksum: `wf:v2:sha256:${'a'.repeat(64)}`,
          executableSchemaVersion: 2,
          executableJson: {},
          compatibilityReleaseEpoch: 1,
        },
      }),
    };
    const scanner: ScheduleTriggerScanner = {
      close: vi.fn().mockResolvedValue(undefined),
      scanDue: vi.fn().mockResolvedValue({
        claimed: 0,
        accepted: 0,
        skipped: 0,
        deferred: 0,
        maxLagSeconds: 0,
      }),
    };
    let runtime: Awaited<ReturnType<typeof createTriggerRuntime>> | undefined;
    let producer: ReturnType<typeof createQueueProducer> | undefined;
    await runWithCleanup(
      async () => {
        runtime = await createTriggerRuntime(
          {
            batchSize: 1,
            database: {
              connectionString:
                'postgresql://unused:unused@localhost:5432/unused',
              connectionTimeoutMillis: 1_000,
              idleTimeoutMillis: 1_000,
              max: 1,
              ownerRole: 'pertexo_owner',
              workerRuntimeRole: 'pertexo_worker',
            },
            leaseDurationSeconds: 5,
            leaseOwner: 'schedule:redis-integration',
            pollIntervalMillis: 100,
            redisUrl: requireRedisUrl(),
            releaseCohort: 'core',
          },
          {
            checkpointFactory: () => ({
              engineVersion: 'test',
              checkpoint: {},
            }),
            reader,
            reconciliation,
            scanner,
          },
        );
        producer = createQueueProducer({ redisUrl: requireRedisUrl() });
        await runtime.consumer.waitUntilReady();
        const publication = await producer.publish({
          name: JOB_NAME.reconcileWorkflowTriggers,
          data: {
            schemaVersion: 1,
            workspaceId,
            workflowId,
            publishedVersionId,
            outboxEventId,
          },
        });
        await vi.waitFor(
          () => {
            expect(reconciliation.reconcile).toHaveBeenCalledTimes(2);
          },
          { timeout: 5_000 },
        );
        expect(reconciliation.recordFailure).toHaveBeenCalledOnce();
        await vi.waitFor(
          async () => {
            const persistedJob = await requireQueue().getJob(publication.jobId);
            await expect(persistedJob?.getState()).resolves.toBe('completed');
            expect(persistedJob?.attemptsMade).toBe(2);
          },
          { timeout: 5_000 },
        );
        await (await requireQueue().getJob(publication.jobId))?.remove();
      },
      async () => {
        const errors: unknown[] = [];
        await producer?.close().catch((error: unknown) => errors.push(error));
        await runtime?.close().catch((error: unknown) => errors.push(error));
        if (errors.length > 0)
          throw new AggregateError(
            errors,
            'Trigger consumer scenario cleanup failed',
          );
      },
      'Trigger consumer scenario',
    );
  });
});
