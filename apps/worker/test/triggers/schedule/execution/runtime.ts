import {
  createOutboxDispatcherDatabase,
  createScheduleTriggerScanner,
} from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';

import { WorkerDrainState } from '../../../../src/runtime/shutdown/drain-state.js';
import { createCoordinatorRuntime } from '../../../../src/runs/runtime.js';
import { createTriggerRuntime } from '../../../../src/triggers/runtime.js';
import { OutboxDispatcher } from '../../../../src/transport/outbox/dispatch/runtime.js';
import { createBenchmarkScanGate } from '../../../support/infrastructure/benchmark-scan-gate.js';
import {
  dispatcherConfig,
  redisUrl,
  workerConfig,
  benchmark,
  registerResource,
  transferResource,
} from '../fixture.js';
import { testTriggerRuntime } from '../../../support/runtime-factories.js';

export async function startScheduleQualification(
  context: Readonly<{
    logger: NonNullable<
      NonNullable<Parameters<typeof createTriggerRuntime>[1]>['logger']
    >;
    scanResults: unknown[];
  }>,
) {
  const { logger, scanResults } = context;
  const runtimeScanner = registerResource(
    createScheduleTriggerScanner(workerConfig, workerConfig),
  );
  benchmark.benchmarkScanGate = createBenchmarkScanGate(
    process.env.PERTEXO_Q11_OPERATION_TIMING === '1',
  );
  const runtime = registerResource(
    await testTriggerRuntime(
      {
        batchSize: 10,
        database: workerConfig,
        leaseDurationSeconds: 5,
        leaseOwner: 'schedule-runtime-one',
        onTimeWindowSeconds: 300,
        pollIntervalMillis: 25,
        redisUrl,
      },
      {
        logger,
        scanner: {
          close: () => {
            return runtimeScanner.close();
          },
          scanDue: async (input) => {
            await benchmark.benchmarkScanGate?.wait(input.signal);
            if (input.signal?.aborted === true) throw input.signal.reason;
            const result = await runtimeScanner.scanDue(input);
            scanResults.push(result);
            return result;
          },
        },
      },
    ),
  );
  transferResource(runtimeScanner);
  await runtime.consumer.waitUntilReady(5_000);
  const coordinator = registerResource(
    await createCoordinatorRuntime({
      maintenanceDatabase: dispatcherConfig,
      database: workerConfig,
      maximumAdmissions: 10,
      redisUrl,
    }),
  );
  await coordinator.consumer.waitUntilReady(5_000);
  const drain = new WorkerDrainState();
  const dispatcherDatabase = registerResource(
    createOutboxDispatcherDatabase(dispatcherConfig),
  );
  const dispatcherProducer = registerResource(
    createQueueProducer({ redisUrl }),
  );
  const dispatcher = registerResource(
    new OutboxDispatcher(dispatcherDatabase, dispatcherProducer, {
      drainState: drain,
      options: {
        batchSize: 10,
        jobNames: [
          JOB_NAME.reconcileWorkflowTriggers,
          JOB_NAME.advanceWorkflowRun,
        ],
        leaseDurationMillis: 1_000,
        leaseOwner: 'schedule-publication-dispatcher',
        maxAttempts: 3,
        operationTimeoutMillis: 5_000,
        retryDelayMillis: 10,
      },
    }),
  );
  transferResource(dispatcherDatabase);
  transferResource(dispatcherProducer);

  return { runtime, dispatcher, scanGate: benchmark.benchmarkScanGate };
}
