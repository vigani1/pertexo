import type { transportMetrics } from '../../support/transport/metrics.js';
import { randomUUID } from 'node:crypto';

import type { createOutboxDispatcherDatabase } from '@pertexo/core/testing';

import { JOB_NAME } from '@pertexo/queue';

import type { Queue } from 'bullmq';

import { describe, vi } from 'vitest';

import { createWorkerTransportTestEnvironment } from '../../support/transport.integration.support.js';

const integration = process.env.WORKER_TRANSPORT_INTEGRATION === 'true';

export const describeIntegration = integration ? describe : describe.skip;

export const TRACEPARENT = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;

type TransportEnvironment = ReturnType<
  typeof createWorkerTransportTestEnvironment
>;

export let transport: TransportEnvironment;

export let apiDatabase: TransportEnvironment['apiDatabase'];

export let checksum: TransportEnvironment['checksum'];

export let consumeProof: TransportEnvironment['consumeProof'];

export let createDispatcher: TransportEnvironment['createDispatcher'];

export let deferred: TransportEnvironment['deferred'];

export let dispatchFairRounds: TransportEnvironment['dispatchFairRounds'];

export let dispatcherUrl: TransportEnvironment['dispatcherUrl'];

export let insertRunEvent: TransportEnvironment['insertRunEvent'];

export let redisConnection: TransportEnvironment['redisConnection'];

export let redisUrl: TransportEnvironment['redisUrl'];

export let workerDatabase: TransportEnvironment['workerDatabase'];

export let workspaceId: TransportEnvironment['workspaceId'];

export async function claimEventAcrossFairRounds(
  database: ReturnType<typeof createOutboxDispatcherDatabase>,
  eventId: string,
) {
  for (let round = 0; round < 3; round += 1) {
    const claimed = await database.claimBatch({
      enabledJobNames: [JOB_NAME.advanceWorkflowRun],
      leaseDurationMillis: 1_000,
      leaseOwner: 'integration-crashed',
      leaseToken: randomUUID(),
      limit: 100,
    });
    const event = claimed.events.find((candidate) => candidate.id === eventId);
    if (event !== undefined) return event;
  }
  throw new Error('Proof event was not claimed within bounded fair rounds');
}

export async function waitForRemovableJob(
  queue: Queue,
  id: string,
): Promise<void> {
  await vi.waitUntil(
    async () => {
      const job = await queue.getJob(id);
      const state = await job?.getState();
      return state === 'delayed' || state === 'failed';
    },
    { timeout: 10_000, interval: 20 },
  );
}

export async function waitForBalancedConsumerMetrics(
  metrics: ReturnType<typeof transportMetrics>,
  minimumHandlers: number,
): Promise<void> {
  await vi.waitUntil(
    () => {
      const deltas = metrics.addActiveConcurrency.mock.calls.map(
        ([measurement]) => measurement.delta,
      );
      const started = deltas.filter((delta) => delta === 1).length;
      const finished = deltas.filter((delta) => delta === -1).length;
      return started >= minimumHandlers && finished === started;
    },
    { timeout: 5_000, interval: 10 },
  );
}

export async function prepareWorkerPostgreSQLRedisTransportProofFixture() {
  transport = createWorkerTransportTestEnvironment();
  await transport.initialize();
  ({
    apiDatabase,
    checksum,
    consumeProof,
    createDispatcher,
    deferred,
    dispatchFairRounds,
    dispatcherUrl,
    insertRunEvent,
    redisConnection,
    redisUrl,
    workerDatabase,
    workspaceId,
  } = transport);
}

export async function closeWorkerPostgreSQLRedisTransportProofFixture() {
  return transport.close();
}
