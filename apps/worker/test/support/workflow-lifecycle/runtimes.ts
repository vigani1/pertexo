import {
  createOutboxDispatcherDatabase,
  createWorkflowTriggerReconciliationDatabase,
} from '@pertexo/core/testing';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';

import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../src/transport/outbox/dispatch/runtime.js';
import type { createTriggerRuntime } from '../../../src/triggers/runtime.js';
import type { TriggerRuntime } from '../../../src/triggers/runtime.js';
import type { createRedisTestNamespace } from '../infrastructure/redis-test-namespace.js';
import type { createLifecycleResourceOwners } from './ownership.js';
import { testTriggerRuntime } from '../runtime-factories.js';

function noOpScanner() {
  return {
    close: (): Promise<void> => Promise.resolve(),
    scanDue: (): Promise<{
      claimed: 0;
      accepted: 0;
      skipped: 0;
      paused: 0;
      deferred: 0;
      maxLagSeconds: 0;
    }> =>
      Promise.resolve({
        claimed: 0,
        accepted: 0,
        skipped: 0,
        paused: 0,
        deferred: 0,
        maxLagSeconds: 0,
      }),
  };
}

export function createLifecycleRuntimes(
  context: Readonly<{
    registerCloseable: ReturnType<
      typeof createLifecycleResourceOwners
    >['registerCloseable'];
    transferResource: ReturnType<
      typeof createLifecycleResourceOwners
    >['transferResource'];
    workerConfig: Parameters<typeof createTriggerRuntime>[0]['database'];
    dispatcherConfig: Parameters<typeof createOutboxDispatcherDatabase>[0];
    redisNamespace: ReturnType<typeof createRedisTestNamespace>;
  }>,
) {
  const {
    registerCloseable,
    transferResource,
    workerConfig,
    dispatcherConfig,
    redisNamespace,
  } = context;
  const createRuntime = async (leaseOwner: string): Promise<TriggerRuntime> => {
    const reconciliation = registerCloseable(
      'trigger reconciliation database',
      createWorkflowTriggerReconciliationDatabase(workerConfig),
    );
    const runtimePromise = testTriggerRuntime(
      {
        batchSize: 10,
        database: workerConfig,
        leaseDurationSeconds: 5,
        leaseOwner,
        onTimeWindowSeconds: 300,
        pollIntervalMillis: 25,
        redisUrl: redisNamespace.redisUrl,
      },
      { reconciliation, scanner: noOpScanner() },
    );
    transferResource(reconciliation);
    const runtime = await runtimePromise;
    registerCloseable('trigger runtime', runtime);
    await runtime.consumer.waitUntilReady(5_000);
    return runtime;
  };

  const createDispatcher = (leaseOwner: string): OutboxDispatcher => {
    const dispatcherDatabase = registerCloseable(
      'outbox dispatcher database',
      createOutboxDispatcherDatabase(dispatcherConfig),
    );
    const producer = registerCloseable(
      'outbox queue producer',
      createQueueProducer({ redisUrl: redisNamespace.redisUrl }),
    );
    const dispatcher = new OutboxDispatcher(dispatcherDatabase, producer, {
      drainState: new WorkerDrainState(),
      options: {
        batchSize: 10,
        jobNames: [JOB_NAME.reconcileWorkflowTriggers],
        leaseDurationMillis: 1_000,
        leaseOwner,
        operationTimeoutMillis: 5_000,
        retryDelayMillis: 10,
      },
    });
    transferResource(dispatcherDatabase);
    transferResource(producer);
    registerCloseable('outbox dispatcher', dispatcher);
    return dispatcher;
  };

  return { createRuntime, createDispatcher };
}
