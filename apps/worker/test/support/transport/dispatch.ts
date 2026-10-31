import {
  createOutboxDispatcherDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';

import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../src/transport/outbox/dispatch/runtime.js';

export function createTransportDispatchControls(
  context: Readonly<{ dispatcherUrl: string; redisUrl: string }>,
) {
  const { dispatcherUrl, redisUrl } = context;
  const dispatchFairRounds = async (
    dispatchers: readonly OutboxDispatcher[],
    expectedClaims: number,
  ): Promise<
    Readonly<{ claimed: number; failed: number; published: number }>
  > => {
    const totals = { claimed: 0, failed: 0, published: 0 };
    const maximumRounds = expectedClaims + 2;
    for (let round = 0; round < maximumRounds; round += 1) {
      const results = await Promise.all(
        dispatchers.map((dispatcher) => dispatcher.dispatchOnce()),
      );
      for (const result of results) {
        totals.claimed += result.claimed;
        totals.failed += result.failed;
        totals.published += result.published;
      }
      if (totals.claimed >= expectedClaims) return totals;
    }
    throw new Error(
      `Fair dispatch did not claim ${String(expectedClaims)} events within ${String(maximumRounds)} rounds: ${JSON.stringify(totals)}`,
    );
  };

  const createDispatcher = (
    owner: string,
    batchSize = 100,
    jobNames: readonly (typeof JOB_NAME)[keyof typeof JOB_NAME][] = [
      JOB_NAME.advanceWorkflowRun,
      JOB_NAME.executeNodeAttempt,
    ],
  ): OutboxDispatcher =>
    new OutboxDispatcher(
      createOutboxDispatcherDatabase(
        parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 }),
      ),
      createQueueProducer({ redisUrl }),
      {
        drainState: new WorkerDrainState(),
        options: {
          batchSize,
          jobNames,
          leaseDurationMillis: 1_000,
          leaseOwner: owner,
          operationTimeoutMillis: 5_000,
          retryDelayMillis: 100,
        },
      },
    );

  return { dispatchFairRounds, createDispatcher };
}
