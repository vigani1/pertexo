import { createCheckpoint } from '@pertexo/workflow-engine';
import type {
  NodeAttemptLease,
  NodeAttemptRunStore,
  PublishedWorkflow,
} from '@pertexo/database/testing';
import {
  JOB_NAME,
  type QueueDelivery,
  type QueueConsumerOptions,
  type QueueJobHandler,
} from '@pertexo/queue';
import type { NodeExecutionRegistry } from '@pertexo/workflow-engine';
import type { FactoryProvider } from '@nestjs/common';
import { vi } from 'vitest';
import type {
  NodeAttemptExecutionEngine,
  NodeAttemptRuntime,
} from '../../../src/testing.js';

import type { WorkerConfig } from '../../../src/config/worker.js';
import { testNodeAttemptRuntime } from '../../support/runtime-factories.js';

export const STORED_CHECKPOINT = createCheckpoint({
  workflowVersionId: '33333333-3333-4333-8333-333333333333',
  iterationBudget: 0,
  nextEventSequence: 2,
});

export const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

export const RUN_ID = '22222222-2222-4222-8222-222222222222';

export const NODE_RUN_ID = '33333333-3333-4333-8333-333333333333';

export const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';

export const OUTBOX_EVENT_ID = '55555555-5555-4555-8555-555555555555';

const VERSION_ID = '66666666-6666-4666-8666-666666666666';

const WORKFLOW_ID = '77777777-7777-4777-8777-777777777777';

export const database = {
  connectionString: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  max: 5,
  ownerRole: 'pertexo_owner',
} as const;

export function providerConfig(): WorkerConfig {
  return {
    database,
    nodeAttempt: {
      heartbeatIntervalMillis: 10,
      leaseDurationSeconds: 30,
      workerId: 'worker-1',
    },
    redisUrl: 'redis://localhost:6379/0',
  } as unknown as WorkerConfig;
}

export function providerFactory(provider: FactoryProvider) {
  return provider.useFactory as (
    observer: QueueConsumerOptions['observer'],
  ) => Promise<NodeAttemptRuntime>;
}

export function delivery(): Extract<
  QueueDelivery,
  { name: 'execute-node-attempt' }
> {
  return {
    name: JOB_NAME.executeNodeAttempt,
    data: {
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      nodeRunId: NODE_RUN_ID,
      attemptId: ATTEMPT_ID,
      outboxEventId: OUTBOX_EVENT_ID,
    },
    transport: { attemptsMade: 0, jobId: `outbox-${OUTBOX_EVENT_ID}` },
  };
}

function projection(): PublishedWorkflow {
  return {
    id: VERSION_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: WORKFLOW_ID,
    versionNumber: 1,
    checksum:
      'wf:sha256:1111111111111111111111111111111111111111111111111111111111111111',
    executableJson: {},
  };
}

export function lease(): NodeAttemptLease {
  return {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    workflowVersionId: VERSION_ID,
    nodeRunId: NODE_RUN_ID,
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    admissionKind: 'execute',
    invocationKey: `${VERSION_ID}|manual|b:|i:`,
    nodeId: 'manual',
    sideEffectClass: 'safe',
    workerId: 'worker-1',
    fenceToken: 1,
    leaseExpiresAt: new Date('2026-08-21T00:01:00.000Z'),
    delivery: {
      outboxEventId: OUTBOX_EVENT_ID,
      payloadChecksum: 'a'.repeat(64),
    },
  };
}

export async function capturedHandler(
  input: Readonly<{
    runStore: NodeAttemptRunStore;
    engine: NodeAttemptExecutionEngine;
    registry: NodeExecutionRegistry;
  }>,
): Promise<
  Readonly<{ handler: QueueJobHandler; runtime: NodeAttemptRuntime }>
> {
  let handler: QueueJobHandler | undefined;
  const runtime = await testNodeAttemptRuntime(
    {
      database,
      heartbeatIntervalMillis: 10,
      leaseDurationSeconds: 30,
      redisUrl: 'redis://localhost:6379/0',
      workerId: 'worker-1',
    },
    {
      consumerFactory: (options) => {
        handler = options.handler;
        return {
          close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
          isReady: vi.fn().mockReturnValue(true),
          waitUntilReady: vi.fn().mockResolvedValue(undefined),
        };
      },
      engine: input.engine,
      notifications: {
        close: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn(),
        resync: vi.fn(),
      },
      reader: {
        close: vi.fn().mockResolvedValue(undefined),
        readForExecution: vi.fn().mockResolvedValue(projection()),
      },
      registry: input.registry,
      runStore: input.runStore,
    },
  );
  if (handler === undefined)
    throw new Error('Consumer handler was not captured');
  return { handler, runtime };
}
