import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  createOutboxDispatcherDatabase,
  type LeasedOutboxEvent,
} from '@pertexo/core/outbox';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';
import { createTransportMetrics } from '@pertexo/observability';

import { createMaintenanceRuntime } from '../../../src/maintenance/runtime.js';
import { OutboxDispatcher } from '../../../src/transport/outbox/dispatch/runtime.js';

import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';

import type { configSchema } from './configuration.js';

export async function captureAbandonedHealthClaim(
  input: Readonly<{
    configuration: z.output<typeof configSchema>;
    redisUrl: string;
    leaseDurationMillis: number;
  }>,
) {
  const { configuration, redisUrl, leaseDurationMillis } = input;
  const cleanup: (() => Promise<void>)[] = [];
  let originalFailure: unknown;
  let result:
    | Readonly<{
        outboxEventId: string;
        leaseToken: string;
        leaseOwner: string;
        leaseExpiresAt: string;
        publishCalls: number;
        releaseCalls: number;
        markCalls: number;
      }>
    | undefined;
  try {
    const database = parseDatabaseConfig({
      connectionString: configuration.workerUrl,
      max: 2,
    });
    const maintenance = await createMaintenanceRuntime({
      database,
      redisUrl: redisUrl,
    });
    cleanup.push(() => maintenance.close());
    const store = createOutboxDispatcherDatabase(
      parseDatabaseConfig({
        connectionString: configuration.dispatcherUrl,
        max: 2,
      }),
    );
    cleanup.push(() => store.close());
    const producer = createQueueProducer({ redisUrl: redisUrl });
    cleanup.push(() => producer.close());
    let claimed: LeasedOutboxEvent | undefined;
    let publishCalls = 0,
      releaseCalls = 0,
      markCalls = 0;
    const interruption = new Error('Owned publication interrupted after claim');
    const dispatcher = new OutboxDispatcher(
      {
        ...store,
        claimBatch: async (input) => {
          const result = await store.claimBatch(input);
          if (result.events.length !== 1)
            throw new Error('Expected one owned health claim');
          claimed = result.events[0];
          // Never return the event: the dispatcher cannot publish, settle, or release it.
          throw interruption;
        },
        releaseOrFail: (input) => {
          releaseCalls += 1;
          return store.releaseOrFail(input);
        },
        markPublished: (id, token) => {
          markCalls += 1;
          return store.markPublished(id, token);
        },
      },
      {
        close: () => producer.close(),
        observe: () => producer.observe(),
        isReady: () => producer.isReady(),
        waitUntilReady: (timeout) => producer.waitUntilReady(timeout),
        publish: (job) => {
          publishCalls += 1;
          return producer.publish(job);
        },
      },
      {
        drainState: new WorkerDrainState(),
        options: {
          jobNames: [JOB_NAME.applyConnectionHealthObservation],
          batchSize: 1,
          leaseDurationMillis: leaseDurationMillis,
          leaseOwner: `health-abandoned-${randomUUID()}`,
          operationTimeoutMillis: 5000,
          pollIntervalMillis: 50,
          retryDelayMillis: 100,
        },
        metrics: createTransportMetrics(),
      },
    );
    cleanup.splice(1, 2, () => dispatcher.close());
    await maintenance.consumer.waitUntilReady(5000);
    await maintenance.checkReadiness();
    await dispatcher.checkReadiness();
    try {
      await dispatcher.dispatchOnce();
      throw new Error('Expected dispatch interruption');
    } catch (error: unknown) {
      if (error !== interruption) throw error;
    }
    if (
      claimed === undefined ||
      publishCalls !== 0 ||
      releaseCalls !== 0 ||
      markCalls !== 0
    )
      throw new Error(
        'Health publication was not abandoned before acknowledgment',
      );
    result = {
      outboxEventId: claimed.id,
      leaseToken: claimed.leaseToken,
      leaseOwner: claimed.leaseOwner,
      leaseExpiresAt: claimed.leaseExpiresAt.toISOString(),
      publishCalls,
      releaseCalls,
      markCalls,
    };
  } catch (error: unknown) {
    originalFailure = error;
  }
  // Closing dependencies never repairs the durable claim unknown to the dispatcher.
  const failures: unknown[] = [];
  for (const close of cleanup.toReversed()) {
    try {
      await close();
    } catch (error: unknown) {
      failures.push(error);
    }
  }

  return { result, originalFailure, failures };
}
