import { randomUUID } from 'node:crypto';

import {
  createOutboxDispatcherDatabase,
  parseDatabaseConfig,
} from '@pertexo/database';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';

import type { createCoordinatorRuntime } from '../../src/execution/coordinator-runtime.js';
import type { createPreviewMaintenanceRuntime } from '../../src/execution/preview-maintenance-runtime.js';
import { WorkerDrainState } from '../../src/runtime/worker-drain-state.js';
import { createDispatchConsumerCapabilityRegistry } from '../../src/transport/dispatch-consumer-capabilities.js';
import { OutboxDispatcher } from '../../src/transport/outbox-dispatcher.js';
import {
  databaseUrl,
  dispatcherUrl,
  redisUrl,
} from '../coordinator-consumer.fixtures.js';

export function createCoordinatorDispatcher(
  consumer: Awaited<ReturnType<typeof createCoordinatorRuntime>>['consumer'],
  dispatcherRedisUrl: string = redisUrl,
): OutboxDispatcher {
  return new OutboxDispatcher(
    createOutboxDispatcherDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(dispatcherUrl),
        max: 2,
      }),
    ),
    createQueueProducer({ redisUrl: dispatcherRedisUrl }),
    new WorkerDrainState(),
    {
      batchSize: 10,
      enabledJobNames: [JOB_NAME.advanceWorkflowRun],
      leaseDurationMillis: 1_000,
      leaseOwner: `due-wakeup-${randomUUID()}`,
      maxAttempts: 3,
      operationTimeoutMillis: 2_000,
      pollIntervalMillis: 25,
      retryDelayMillis: 25,
    },
    undefined,
    createDispatchConsumerCapabilityRegistry([
      { jobName: JOB_NAME.advanceWorkflowRun, consumer },
    ]),
  );
}

export function createFailureNotificationDispatcher(
  consumer: Awaited<
    ReturnType<typeof createPreviewMaintenanceRuntime>
  >['consumer'],
  drainState: WorkerDrainState = new WorkerDrainState(),
): OutboxDispatcher {
  return new OutboxDispatcher(
    createOutboxDispatcherDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(dispatcherUrl),
        max: 2,
      }),
    ),
    createQueueProducer({ redisUrl }),
    drainState,
    {
      batchSize: 10,
      enabledJobNames: [JOB_NAME.deliverRunFailureNotification],
      leaseDurationMillis: 1_000,
      leaseOwner: `failure-notification-${randomUUID()}`,
      maxAttempts: 3,
      operationTimeoutMillis: 2_000,
      pollIntervalMillis: 25,
      retryDelayMillis: 25,
    },
    undefined,
    createDispatchConsumerCapabilityRegistry([
      { jobName: JOB_NAME.deliverRunFailureNotification, consumer },
    ]),
  );
}

export async function dispatchFairRounds(
  dispatcher: OutboxDispatcher,
  expectedClaims: number,
): Promise<Readonly<{ claimed: number; failed: number; published: number }>> {
  const totals = { claimed: 0, failed: 0, published: 0 };
  const maximumRounds = expectedClaims + 2;
  for (let round = 0; round < maximumRounds; round += 1) {
    const result = await dispatcher.dispatchOnce();
    totals.claimed += result.claimed;
    totals.failed += result.failed;
    totals.published += result.published;
    if (totals.claimed >= expectedClaims) return totals;
  }
  throw new Error(
    `Fair dispatch did not claim ${String(expectedClaims)} events within ${String(maximumRounds)} rounds: ${JSON.stringify(totals)}`,
  );
}
