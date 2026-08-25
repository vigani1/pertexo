import { canonicalOutboxPayloadChecksum } from '@pertexo/database';
import type {
  LeasedOutboxEvent,
  OutboxDispatcherDatabase,
  ReleaseOutboxResult,
} from '@pertexo/database';
import type { TransportMetrics } from '@pertexo/observability/transport-metrics';
import { JOB_NAME, type QueueJob, type QueueProducer } from '@pertexo/queue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/unbound-method -- assertions target injected boundary fakes */

import {
  createDispatchConsumerCapabilityRegistry,
  DispatchConsumerCapabilityError,
  type DispatchConsumerCapabilityRegistry,
} from '../src/transport/dispatch-consumer-capabilities.js';
import {
  OutboxDispatcher,
  OutboxPayloadChecksumError,
} from '../src/transport/outbox-dispatcher.js';
import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const LEASE_TOKEN = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = '44444444-4444-4444-8444-444444444444';

function checksum(value: unknown): string {
  return canonicalOutboxPayloadChecksum(value);
}

function event(overrides: Partial<LeasedOutboxEvent> = {}): LeasedOutboxEvent {
  const payload = overrides.payload ?? { runId: RUN_ID };
  const defaults: LeasedOutboxEvent = {
    aggregateId: RUN_ID,
    aggregateType: 'workflow-run',
    availableAt: new Date(0),
    id: EVENT_ID,
    jobName: JOB_NAME.advanceWorkflowRun,
    leaseExpiresAt: new Date(Date.now() + 30_000),
    leaseOwner: 'worker-a',
    leaseToken: LEASE_TOKEN,
    payload,
    payloadChecksum: checksum(payload),
    publishAttempts: 1,
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
  };
  return Object.freeze({
    ...defaults,
    ...overrides,
    payload,
    payloadChecksum: overrides.payloadChecksum ?? checksum(payload),
  });
}

function boundaries(events: readonly LeasedOutboxEvent[] = [event()]): {
  database: OutboxDispatcherDatabase;
  producer: QueueProducer;
} {
  return {
    database: {
      checkReadiness: vi.fn().mockResolvedValue(undefined),
      claimBatch: vi.fn().mockResolvedValue({ events, exhaustedCount: 0 }),
      close: vi.fn().mockResolvedValue(undefined),
      markPublished: vi.fn().mockResolvedValue(true),
      observeBacklog: vi
        .fn()
        .mockResolvedValue({ backlog: 7, oldestAgeSeconds: 12 }),
      releaseOrFail: vi
        .fn<(_input: unknown) => Promise<ReleaseOutboxResult>>()
        .mockResolvedValue('retry_scheduled'),
    },
    producer: {
      close: vi.fn().mockResolvedValue(undefined),
      isReady: vi.fn().mockReturnValue(true),
      observe: vi.fn().mockResolvedValue([
        {
          depth: 3,
          oldestJobAgeSeconds: 2,
          queueName: 'workflow-coordinator',
        },
      ]),
      publish: vi.fn().mockResolvedValue({
        jobId: `outbox-${EVENT_ID}`,
        jobName: JOB_NAME.advanceWorkflowRun,
        queueName: 'workflow-coordinator',
      }),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function transportMetrics(): TransportMetrics {
  return {
    addActiveConcurrency: vi.fn(),
    observeArtifacts: vi.fn(),
    observeOutbox: vi.fn(),
    observeQueue: vi.fn(),
    recordHandlerFinished: vi.fn(),
    recordConsumerLifecycle: vi.fn(),
    recordOutboxClaim: vi.fn(),
    recordOutboxLeaseEvent: vi.fn(),
    recordOutboxPublish: vi.fn(),
    recordOutboxDispatchLatency: vi.fn(),
    recordQueueStall: vi.fn(),
    recordWorkerProcessStart: vi.fn(),
  };
}

function createDispatcher(
  selected = boundaries(),
  drainState = new WorkerDrainState(),
  metrics = transportMetrics(),
  consumerCapabilities: DispatchConsumerCapabilityRegistry = readyCapabilities([
    JOB_NAME.advanceWorkflowRun,
    JOB_NAME.expireArtifacts,
  ]),
): OutboxDispatcher {
  return new OutboxDispatcher(
    selected.database,
    selected.producer,
    drainState,
    {
      batchSize: 10,
      enabledJobNames: [JOB_NAME.advanceWorkflowRun, JOB_NAME.expireArtifacts],
      leaseDurationMillis: 30_000,
      leaseOwner: 'worker-a',
      maxAttempts: 3,
      pollIntervalMillis: 10,
      retryDelayMillis: 1_000,
    },
    metrics,
    consumerCapabilities,
  );
}

function readyCapabilities(
  jobNames: readonly (typeof JOB_NAME)[keyof typeof JOB_NAME][],
): DispatchConsumerCapabilityRegistry {
  return createDispatchConsumerCapabilityRegistry(
    jobNames.map((jobName) => ({
      jobName,
      consumer: {
        isReady: () => true,
        waitUntilReady: () => Promise.resolve(),
      },
    })),
  );
}

describe('outbox dispatcher', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('accepts trigger reconciliation as a dispatcher build capability', () => {
    const selected = boundaries([]);

    expect(
      new OutboxDispatcher(
        selected.database,
        selected.producer,
        new WorkerDrainState(),
        {
          batchSize: 10,
          enabledJobNames: [JOB_NAME.reconcileWorkflowTriggers],
          leaseDurationMillis: 30_000,
          leaseOwner: 'worker-a',
          maxAttempts: 3,
          pollIntervalMillis: 10,
          retryDelayMillis: 1_000,
        },
      ),
    ).toBeInstanceOf(OutboxDispatcher);
  });

  it('holds every row when no dispatch kind or consumer is composed', async () => {
    const selected = boundaries([event()]);
    const dispatcher = new OutboxDispatcher(
      selected.database,
      selected.producer,
      new WorkerDrainState(),
      {
        batchSize: 10,
        enabledJobNames: [],
        leaseDurationMillis: 30_000,
        leaseOwner: 'worker-a',
        maxAttempts: 3,
        pollIntervalMillis: 10,
        retryDelayMillis: 1_000,
      },
    );

    await expect(dispatcher.checkReadiness()).resolves.toBeUndefined();
    await expect(dispatcher.dispatchOnce()).resolves.toEqual({
      claimed: 0,
      failed: 0,
      published: 0,
      stale: 0,
    });
    expect(selected.database.claimBatch).not.toHaveBeenCalled();
    expect(selected.producer.publish).not.toHaveBeenCalled();
  });

  it('fails readiness and refuses claims when configuration lacks a ready consumer', async () => {
    const selected = boundaries([event()]);
    const dispatcher = new OutboxDispatcher(
      selected.database,
      selected.producer,
      new WorkerDrainState(),
      {
        batchSize: 10,
        enabledJobNames: [JOB_NAME.advanceWorkflowRun],
        leaseDurationMillis: 30_000,
        leaseOwner: 'worker-a',
        maxAttempts: 3,
        pollIntervalMillis: 10,
        retryDelayMillis: 1_000,
      },
    );

    await expect(dispatcher.checkReadiness()).rejects.toBeInstanceOf(
      DispatchConsumerCapabilityError,
    );
    await expect(dispatcher.dispatchOnce()).rejects.toBeInstanceOf(
      DispatchConsumerCapabilityError,
    );
    expect(selected.database.claimBatch).not.toHaveBeenCalled();
    expect(selected.producer.publish).not.toHaveBeenCalled();
  });

  it('publishes a validated queue contract and conditionally marks its lease', async () => {
    const selected = boundaries();
    const metrics = transportMetrics();
    const dispatcher = createDispatcher(
      selected,
      new WorkerDrainState(),
      metrics,
    );

    await expect(dispatcher.dispatchOnce()).resolves.toEqual({
      claimed: 1,
      failed: 0,
      published: 1,
      stale: 0,
    });
    expect(selected.producer.publish).toHaveBeenCalledWith({
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        outboxEventId: EVENT_ID,
        runId: RUN_ID,
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
      },
    } satisfies QueueJob);
    expect(selected.database.markPublished).toHaveBeenCalledWith(
      EVENT_ID,
      LEASE_TOKEN,
    );
    expect(selected.database.claimBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        enabledJobNames: [
          JOB_NAME.advanceWorkflowRun,
          JOB_NAME.expireArtifacts,
        ],
      }),
    );
    expect(metrics.recordOutboxClaim).toHaveBeenCalledWith({ batchSize: 1 });
    expect(metrics.recordOutboxPublish).toHaveBeenCalledWith({
      jobName: JOB_NAME.advanceWorkflowRun,
      outcome: 'published',
      queueName: 'workflow-coordinator',
    });
    const latency = vi.mocked(metrics.recordOutboxDispatchLatency).mock
      .calls[0]?.[0];
    expect(latency).toMatchObject({
      jobName: JOB_NAME.advanceWorkflowRun,
      outcome: 'published',
      queueName: 'workflow-coordinator',
    });
    expect(latency?.durationSeconds).toBeTypeOf('number');
    expect(metrics.observeQueue).toHaveBeenCalledWith({
      depth: 3,
      oldestJobAgeSeconds: 2,
      queueName: 'workflow-coordinator',
    });
    expect(metrics.observeOutbox).toHaveBeenCalledWith({
      backlog: 7,
      oldestAgeSeconds: 12,
    });
    expect(selected.database.observeBacklog).toHaveBeenCalledWith({
      enabledJobNames: [JOB_NAME.advanceWorkflowRun, JOB_NAME.expireArtifacts],
    });
  });

  it('observes queue metrics only for enabled dispatch capabilities', async () => {
    const selected = boundaries([]);
    vi.mocked(selected.producer.observe).mockResolvedValue([
      {
        depth: 3,
        oldestJobAgeSeconds: 2,
        queueName: 'workflow-coordinator',
      },
      {
        depth: 99,
        oldestJobAgeSeconds: 90,
        queueName: 'trigger-lifecycle',
      },
    ]);
    const metrics = transportMetrics();

    await createDispatcher(
      selected,
      new WorkerDrainState(),
      metrics,
    ).dispatchOnce();

    expect(metrics.observeQueue).toHaveBeenCalledOnce();
    expect(metrics.observeQueue).toHaveBeenCalledWith({
      depth: 3,
      oldestJobAgeSeconds: 2,
      queueName: 'workflow-coordinator',
    });
  });

  it('samples tenant artifact capacity after durable maintenance publication', async () => {
    const artifactId = '55555555-5555-4555-8555-555555555555';
    const payload = { artifactId };
    const selected = boundaries([
      event({
        aggregateId: artifactId,
        aggregateType: 'artifact',
        jobName: JOB_NAME.expireArtifacts,
        payload,
        payloadChecksum: checksum(payload),
      }),
    ]);
    const observeArtifactCapacity = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createDispatcher(selected);
    dispatcher.configureRuntimeHooks({ observeArtifactCapacity });

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      published: 1,
    });
    expect(observeArtifactCapacity).toHaveBeenCalledOnce();
    expect(observeArtifactCapacity).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it('does not change durable publication when artifact sampling fails', async () => {
    const artifactId = '55555555-5555-4555-8555-555555555555';
    const payload = { artifactId };
    const selected = boundaries([
      event({
        aggregateId: artifactId,
        aggregateType: 'artifact',
        jobName: JOB_NAME.expireArtifacts,
        payload,
        payloadChecksum: checksum(payload),
      }),
    ]);
    const dispatcher = createDispatcher(selected);
    dispatcher.configureRuntimeHooks({
      observeArtifactCapacity: vi
        .fn()
        .mockRejectedValue(new Error('metric query failed')),
    });

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      failed: 0,
      published: 1,
    });
  });

  it('records retry claims, stale leases, and exhausted attempts without dynamic labels', async () => {
    const retried = boundaries([event({ publishAttempts: 2 })]);
    vi.mocked(retried.database.markPublished).mockResolvedValue(false);
    const staleMetrics = transportMetrics();

    await createDispatcher(
      retried,
      new WorkerDrainState(),
      staleMetrics,
    ).dispatchOnce();

    expect(staleMetrics.recordOutboxLeaseEvent).toHaveBeenCalledWith(
      'reclaimed',
    );
    expect(staleMetrics.recordOutboxLeaseEvent).toHaveBeenCalledWith('expired');

    const exhausted = boundaries();
    vi.mocked(exhausted.producer.publish).mockRejectedValue(
      new Error('redis unavailable'),
    );
    vi.mocked(exhausted.database.releaseOrFail).mockResolvedValue('failed');
    const exhaustedMetrics = transportMetrics();

    await createDispatcher(
      exhausted,
      new WorkerDrainState(),
      exhaustedMetrics,
    ).dispatchOnce();

    expect(exhaustedMetrics.recordOutboxPublish).toHaveBeenCalledWith({
      errorClass: 'redis',
      jobName: JOB_NAME.advanceWorkflowRun,
      outcome: 'failed',
      queueName: 'workflow-coordinator',
    });
    expect(exhaustedMetrics.recordOutboxLeaseEvent).toHaveBeenCalledWith(
      'attempt_exhausted',
    );
  });

  it('records claim-time exhaustion as one bounded counter increment', async () => {
    const selected = boundaries([]);
    vi.mocked(selected.database.claimBatch).mockResolvedValue({
      events: [],
      exhaustedCount: 2,
    });
    const metrics = transportMetrics();

    await createDispatcher(
      selected,
      new WorkerDrainState(),
      metrics,
    ).dispatchOnce();

    expect(metrics.recordOutboxLeaseEvent).toHaveBeenCalledWith(
      'attempt_exhausted',
      2,
    );
  });

  it('does not let a metrics failure alter durable dispatch', async () => {
    const selected = boundaries();
    const metrics = transportMetrics();
    vi.mocked(metrics.recordOutboxPublish).mockImplementation(() => {
      throw new Error('metrics unavailable');
    });

    await expect(
      createDispatcher(
        selected,
        new WorkerDrainState(),
        metrics,
      ).dispatchOnce(),
    ).resolves.toEqual(expect.objectContaining({ published: 1 }));
    expect(selected.database.markPublished).toHaveBeenCalledOnce();
  });

  it('accepts canonically equivalent payload key order', async () => {
    const traceparent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    const payload = { runId: RUN_ID, traceparent };
    const reordered = { traceparent, runId: RUN_ID };
    const selected = boundaries([
      event({
        payload: reordered,
        payloadChecksum: checksum(payload),
      }),
    ]);

    await expect(createDispatcher(selected).dispatchOnce()).resolves.toEqual(
      expect.objectContaining({ published: 1 }),
    );
  });

  it('fails a checksum mismatch through the bounded release seam without publishing', async () => {
    const selected = boundaries([event({ payloadChecksum: '0'.repeat(64) })]);
    const metrics = transportMetrics();
    const dispatcher = createDispatcher(
      selected,
      new WorkerDrainState(),
      metrics,
    );

    await expect(dispatcher.dispatchOnce()).resolves.toEqual({
      claimed: 1,
      failed: 1,
      published: 0,
      stale: 0,
    });
    expect(selected.producer.publish).not.toHaveBeenCalled();
    expect(metrics.recordOutboxPublish).toHaveBeenCalledWith({
      errorClass: 'contract',
      jobName: JOB_NAME.advanceWorkflowRun,
      outcome: 'failed',
      queueName: 'workflow-coordinator',
    });
    expect(selected.database.releaseOrFail).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'outbox.checksum_mismatch',
        id: EVENT_ID,
        leaseToken: LEASE_TOKEN,
        maxAttempts: 3,
      }),
    );
  });

  it('releases invalid queue contracts and Redis failures with stable error codes', async () => {
    const invalid = boundaries([event({ payload: { graph: 'not-an-id' } })]);
    const redisFailure = boundaries();
    vi.mocked(redisFailure.producer.publish).mockRejectedValue(
      new Error('redis unavailable'),
    );

    await createDispatcher(invalid).dispatchOnce();
    await createDispatcher(redisFailure).dispatchOnce();

    expect(invalid.database.releaseOrFail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'outbox.invalid_contract' }),
    );
    expect(redisFailure.database.releaseOrFail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'queue.publish_failed' }),
    );
  });

  it('stops claiming as soon as drain begins', async () => {
    const selected = boundaries();
    const drainState = new WorkerDrainState();
    const dispatcher = createDispatcher(selected, drainState);
    drainState.beginDrain();

    await expect(dispatcher.dispatchOnce()).resolves.toEqual({
      claimed: 0,
      failed: 0,
      published: 0,
      stale: 0,
    });
    expect(selected.database.claimBatch).not.toHaveBeenCalled();
  });

  it('checks both boundaries and closes them idempotently', async () => {
    const selected = boundaries();
    const dispatcher = createDispatcher(selected);

    await expect(dispatcher.checkReadiness()).resolves.toBeUndefined();
    await dispatcher.close();
    await dispatcher.close();

    expect(selected.database.checkReadiness).toHaveBeenCalledOnce();
    expect(selected.producer.waitUntilReady).toHaveBeenCalledOnce();
    expect(selected.database.close).toHaveBeenCalledOnce();
    expect(selected.producer.close).toHaveBeenCalledOnce();
    await expect(dispatcher.dispatchOnce()).rejects.toThrow('closed');
  });

  it('recovers its polling loop after a transient claim failure', async () => {
    vi.useFakeTimers();
    const selected = boundaries([]);
    vi.mocked(selected.database.claimBatch)
      .mockRejectedValueOnce(new Error('postgres restarted'))
      .mockResolvedValue({ events: [], exhaustedCount: 0 });
    const drainState = new WorkerDrainState();
    const dispatcher = createDispatcher(selected, drainState);

    dispatcher.start();
    await vi.advanceTimersByTimeAsync(25);
    drainState.beginDrain();
    await dispatcher.close();

    expect(
      vi.mocked(selected.database.claimBatch).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('attempts every cleanup when the loop or one close boundary fails', async () => {
    const selected = boundaries([]);
    vi.mocked(selected.database.close).mockRejectedValue(
      new Error('db close failed'),
    );
    const drainState = {
      canAcceptWork: vi
        .fn()
        .mockReturnValueOnce(true)
        .mockImplementation(() => {
          throw new Error('loop failed');
        }),
    } as unknown as WorkerDrainState;
    const dispatcher = createDispatcher(selected, drainState);
    dispatcher.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(dispatcher.close()).rejects.toThrow();
    expect(selected.database.close).toHaveBeenCalledOnce();
    expect(selected.producer.close).toHaveBeenCalledOnce();
  });

  it('exposes a typed checksum error without including payload data', () => {
    const error = new OutboxPayloadChecksumError(EVENT_ID);

    expect(error.message).toContain(EVENT_ID);
    expect(error.message).not.toContain(RUN_ID);
  });
});
