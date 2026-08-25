import { randomUUID } from 'node:crypto';

import type {
  PublishedWorkflowReader,
  ScheduleTriggerScanner,
  WorkflowTriggerReconciliationDatabase,
} from '@pertexo/database';
import { createQueueProducer, JOB_NAME, QUEUE_NAME } from '@pertexo/queue';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/unbound-method -- assertions target injected seam fakes */

import { createTriggerRuntime } from '../src/triggers/trigger-runtime.js';

const enabled = process.env.WORKER_TRANSPORT_INTEGRATION === 'true';
const describeIntegration = enabled ? describe : describe.skip;
const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';
const redisUrl = (() => {
  const parsed = new URL(configuredRedisUrl);
  parsed.pathname = '/14';
  return parsed.toString();
})();

function bullConnection() {
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
  const queue = new Queue(QUEUE_NAME.triggerLifecycle, {
    connection: bullConnection(),
  });

  beforeAll(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('redelivers a transient reconciliation failure and commits it once', async () => {
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
    const runtime = await createTriggerRuntime(
      {
        batchSize: 1,
        database: {
          connectionString: 'postgresql://unused:unused@localhost:5432/unused',
          connectionTimeoutMillis: 1_000,
          idleTimeoutMillis: 1_000,
          max: 1,
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        },
        leaseDurationSeconds: 5,
        leaseOwner: 'schedule:redis-integration',
        pollIntervalMillis: 100,
        redisUrl,
        releaseCohort: 'core',
      },
      {
        checkpointFactory: () => ({ engineVersion: 'test', checkpoint: {} }),
        reader,
        reconciliation,
        scanner,
      },
    );
    const producer = createQueueProducer({ redisUrl });
    try {
      await runtime.consumer.waitUntilReady();
      await producer.publish({
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
    } finally {
      await producer.close();
      await runtime.close();
    }
  });
});
