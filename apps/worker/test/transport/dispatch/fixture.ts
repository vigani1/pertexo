import { randomUUID } from 'node:crypto';

import type { createOutboxDispatcherDatabase } from '@pertexo/database/testing';
import type { TransportMetrics } from '@pertexo/observability';

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

export function capturingTransportMetrics() {
  return {
    addActiveConcurrency:
      vi.fn<NonNullable<TransportMetrics['addActiveConcurrency']>>(),
    observeArtifacts:
      vi.fn<NonNullable<TransportMetrics['observeArtifacts']>>(),
    observeExecutionStorage:
      vi.fn<NonNullable<TransportMetrics['observeExecutionStorage']>>(),
    observeOutbox: vi.fn<NonNullable<TransportMetrics['observeOutbox']>>(),
    observeQueue: vi.fn<NonNullable<TransportMetrics['observeQueue']>>(),
    recordHandlerFinished:
      vi.fn<NonNullable<TransportMetrics['recordHandlerFinished']>>(),
    recordConsumerLifecycle:
      vi.fn<NonNullable<TransportMetrics['recordConsumerLifecycle']>>(),
    recordOutboxClaim:
      vi.fn<NonNullable<TransportMetrics['recordOutboxClaim']>>(),
    recordOutboxLeaseEvent:
      vi.fn<NonNullable<TransportMetrics['recordOutboxLeaseEvent']>>(),
    recordOutboxPublish:
      vi.fn<NonNullable<TransportMetrics['recordOutboxPublish']>>(),
    recordOutboxDispatchLatency:
      vi.fn<NonNullable<TransportMetrics['recordOutboxDispatchLatency']>>(),
    recordQueueStall:
      vi.fn<NonNullable<TransportMetrics['recordQueueStall']>>(),
    recordWorkerProcessStart:
      vi.fn<NonNullable<TransportMetrics['recordWorkerProcessStart']>>(),
  } satisfies TransportMetrics;
}

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
      maxAttempts: 3,
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
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = await queue.getJob(id);
    const state = await job?.getState();
    if (state === 'delayed' || state === 'failed') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for removable job ${id}`);
}

export async function waitForBalancedConsumerMetrics(
  metrics: ReturnType<typeof capturingTransportMetrics>,
  minimumHandlers: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const deltas = vi
      .mocked(metrics.addActiveConcurrency)
      .mock.calls.map(([measurement]) => measurement.delta);
    const started = deltas.filter((delta) => delta === 1).length;
    const finished = deltas.filter((delta) => delta === -1).length;
    if (started >= minimumHandlers && finished === started) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for balanced consumer metrics');
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
