import { randomUUID } from 'node:crypto';

import {
  createOutboxDispatcherDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';

import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../src/transport/outbox/dispatcher.js';
import { coordinatorFixture } from './consumer.js';

const { databaseUrl, dispatcherUrl, redisUrl } = coordinatorFixture;

export async function createCoordinatorDispatcher(
  dispatcherRedisUrl: string = redisUrl,
): Promise<OutboxDispatcher> {
  const database = createOutboxDispatcherDatabase(
    parseDatabaseConfig({
      connectionString: databaseUrl(dispatcherUrl),
      max: 2,
    }),
  );
  let producer: ReturnType<typeof createQueueProducer> | undefined;
  try {
    producer = createQueueProducer({ redisUrl: dispatcherRedisUrl });
    return new OutboxDispatcher(database, producer, new WorkerDrainState(), {
      batchSize: 10,
      jobNames: [JOB_NAME.advanceWorkflowRun],
      leaseDurationMillis: 1_000,
      leaseOwner: `due-wakeup-${randomUUID()}`,
      maxAttempts: 3,
      operationTimeoutMillis: 2_000,
      pollIntervalMillis: 25,
      retryDelayMillis: 25,
    });
  } catch (startupError: unknown) {
    const errors: unknown[] = [startupError];
    if (producer !== undefined)
      await producer.close().catch((error: unknown) => errors.push(error));
    await database.close().catch((error: unknown) => errors.push(error));
    if (errors.length === 1) throw startupError;
    throw new AggregateError(errors, 'Coordinator dispatcher startup failed');
  }
}

export async function createFailureNotificationDispatcher(
  drainState: WorkerDrainState = new WorkerDrainState(),
): Promise<OutboxDispatcher> {
  const database = createOutboxDispatcherDatabase(
    parseDatabaseConfig({
      connectionString: databaseUrl(dispatcherUrl),
      max: 2,
    }),
  );
  let producer: ReturnType<typeof createQueueProducer> | undefined;
  try {
    producer = createQueueProducer({ redisUrl });
    return new OutboxDispatcher(database, producer, drainState, {
      batchSize: 10,
      jobNames: [JOB_NAME.deliverRunFailureNotification],
      leaseDurationMillis: 1_000,
      leaseOwner: `failure-notification-${randomUUID()}`,
      maxAttempts: 3,
      operationTimeoutMillis: 2_000,
      pollIntervalMillis: 25,
      retryDelayMillis: 25,
    });
  } catch (startupError: unknown) {
    const errors: unknown[] = [startupError];
    if (producer !== undefined)
      await producer.close().catch((error: unknown) => errors.push(error));
    await database.close().catch((error: unknown) => errors.push(error));
    if (errors.length === 1) throw startupError;
    throw new AggregateError(
      errors,
      'Failure notification dispatcher startup failed',
    );
  }
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
