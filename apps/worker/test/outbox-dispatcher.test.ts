import { canonicalOutboxPayloadChecksum } from '@pertexo/database/testing';
import type {
  LeasedOutboxEvent,
  OutboxDispatcherDatabase,
  ReleaseOutboxResult,
} from '@pertexo/database/testing';
import type { TransportMetrics } from '@pertexo/observability/transport-metrics';
import { JOB_NAME, type QueueJob, type QueueProducer } from '@pertexo/queue';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { TransportOperationTimeoutError } from '../src/transport/transport-operation-deadline.js';
import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const LEASE_TOKEN = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = '44444444-4444-4444-8444-444444444444';

function indexedId(prefix: string, index: number): string {
  return `${prefix}-${index.toString(16).padStart(12, '0')}`;
}

function indexedEvent(index: number): LeasedOutboxEvent {
  return event({
    id: indexedId('11111111-1111-4111-8111', index),
    workspaceId: indexedId('33333333-3333-4333-8333', index),
  });
}

function checksum(value: unknown): string {
  return canonicalOutboxPayloadChecksum(value);
}

function event(overrides: Partial<LeasedOutboxEvent> = {}): LeasedOutboxEvent {
  const payload = Object.hasOwn(overrides, 'payload')
    ? overrides.payload
    : { runId: RUN_ID };
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
        outcome: 'published',
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
    observeExecutionStorage: vi.fn(),
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
    JOB_NAME.reconcileWorkflowTriggers,
  ]),
  operationTimeoutMillis = 5_000,
): OutboxDispatcher {
  return new OutboxDispatcher(
    selected.database,
    selected.producer,
    drainState,
    {
      batchSize: 10,
      enabledJobNames: [
        JOB_NAME.advanceWorkflowRun,
        JOB_NAME.reconcileWorkflowTriggers,
      ],
      leaseDurationMillis: 30_000,
      leaseOwner: 'worker-a',
      maxAttempts: 3,
      operationTimeoutMillis,
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
  afterEach(() => {
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
      outcomeUnknown: 0,
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
      outcomeUnknown: 0,
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
          JOB_NAME.reconcileWorkflowTriggers,
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
      enabledJobNames: [
        JOB_NAME.advanceWorkflowRun,
        JOB_NAME.reconcileWorkflowTriggers,
      ],
    });
  });

  it('retains the lease while a timed-out publication mark can still settle', async () => {
    vi.useFakeTimers();
    const selected = boundaries();
    const mark = Promise.withResolvers<boolean>();
    vi.mocked(selected.database.markPublished).mockReturnValue(mark.promise);
    const dispatcher = createDispatcher(selected);

    const dispatch = dispatcher.dispatchOnce();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(dispatch).resolves.toEqual({
      claimed: 1,
      failed: 0,
      outcomeUnknown: 1,
      published: 0,
      stale: 0,
    });
    expect(selected.database.releaseOrFail).not.toHaveBeenCalled();

    mark.resolve(true);
    await vi.waitFor(() => {
      expect(selected.database.markPublished).toHaveBeenCalledOnce();
    });
  });

  it('retains the lease and records a late success after an unknown publish outcome', async () => {
    const selected = boundaries();
    const metrics = transportMetrics();
    let settle: ((value: 'failed' | 'published') => void) | undefined;
    const settlement = new Promise<'failed' | 'published'>((resolve) => {
      settle = resolve;
    });
    vi.mocked(selected.producer.publish).mockResolvedValue({
      jobId: `outbox-${EVENT_ID}`,
      jobName: JOB_NAME.advanceWorkflowRun,
      outcome: 'outcome_unknown',
      queueName: 'workflow-coordinator',
      settlement,
    });

    await expect(
      createDispatcher(
        selected,
        new WorkerDrainState(),
        metrics,
      ).dispatchOnce(),
    ).resolves.toEqual({
      claimed: 1,
      failed: 0,
      outcomeUnknown: 1,
      published: 0,
      stale: 0,
    });
    expect(selected.database.releaseOrFail).not.toHaveBeenCalled();
    expect(selected.database.markPublished).not.toHaveBeenCalled();
    expect(metrics.recordOutboxPublish).toHaveBeenCalledWith({
      errorClass: 'timeout',
      jobName: JOB_NAME.advanceWorkflowRun,
      outcome: 'outcome_unknown',
      queueName: 'workflow-coordinator',
    });

    settle?.('published');
    await vi.waitFor(() => {
      expect(selected.database.markPublished).toHaveBeenCalledWith(
        EVENT_ID,
        LEASE_TOKEN,
      );
    });
  });

  it('retains the lease for expiry when an unknown publish settles as failed', async () => {
    const selected = boundaries();
    const settlement = Promise.withResolvers<'failed' | 'published'>();
    vi.mocked(selected.producer.publish).mockResolvedValue({
      jobId: `outbox-${EVENT_ID}`,
      jobName: JOB_NAME.advanceWorkflowRun,
      outcome: 'outcome_unknown',
      queueName: 'workflow-coordinator',
      settlement: settlement.promise,
    });
    const dispatcher = createDispatcher(selected);

    await dispatcher.dispatchOnce();
    const closing = dispatcher.close();
    settlement.resolve('failed');
    await closing;
    expect(selected.database.markPublished).not.toHaveBeenCalled();
    expect(selected.database.releaseOrFail).not.toHaveBeenCalled();
  });

  it('observes a rejected unknown publication settlement without releasing its lease', async () => {
    const selected = boundaries();
    const settlement = Promise.withResolvers<'failed' | 'published'>();
    vi.mocked(selected.producer.publish).mockResolvedValue({
      jobId: `outbox-${EVENT_ID}`,
      jobName: JOB_NAME.advanceWorkflowRun,
      outcome: 'outcome_unknown',
      queueName: 'workflow-coordinator',
      settlement: settlement.promise,
    });
    const dispatcher = createDispatcher(selected);

    await dispatcher.dispatchOnce();
    const closing = dispatcher.close();
    settlement.reject(new Error('late Redis settlement failed'));
    await expect(closing).resolves.toBeUndefined();
    expect(selected.database.markPublished).not.toHaveBeenCalled();
    expect(selected.database.releaseOrFail).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'success', late: true },
    { kind: 'stale', late: false },
    { kind: 'rejection', late: new Error('late mark failed') },
  ] as const)(
    'owns a timed-out publication mark through late $kind settlement',
    async ({ late }) => {
      vi.useFakeTimers();
      const selected = boundaries();
      const mark = Promise.withResolvers<boolean>();
      vi.mocked(selected.database.markPublished).mockReturnValue(mark.promise);
      const dispatcher = createDispatcher(
        selected,
        new WorkerDrainState(),
        transportMetrics(),
        readyCapabilities([
          JOB_NAME.advanceWorkflowRun,
          JOB_NAME.reconcileWorkflowTriggers,
        ]),
        100,
      );

      const dispatch = dispatcher.dispatchOnce();
      await vi.advanceTimersByTimeAsync(100);
      await expect(dispatch).resolves.toMatchObject({ outcomeUnknown: 1 });
      const closing = dispatcher.close();
      await Promise.resolve();
      expect(selected.database.close).not.toHaveBeenCalled();

      if (late instanceof Error) mark.reject(late);
      else mark.resolve(late);
      await expect(closing).resolves.toBeUndefined();
      expect(selected.database.markPublished).toHaveBeenCalledWith(
        EVENT_ID,
        LEASE_TOKEN,
      );
      expect(selected.database.releaseOrFail).not.toHaveBeenCalled();
    },
  );

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
        queueName: 'maintenance',
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

  it('samples workspace capacity after durable workflow publication', async () => {
    const selected = boundaries([event()]);
    const observeWorkspaceCapacity = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createDispatcher(selected);
    dispatcher.configureRuntimeHooks({ observeWorkspaceCapacity });

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      published: 1,
    });
    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      published: 1,
    });
    expect(observeWorkspaceCapacity).toHaveBeenCalledOnce();
    expect(observeWorkspaceCapacity.mock.calls[0]?.[0]).toBe(WORKSPACE_ID);
    expect(observeWorkspaceCapacity.mock.calls[0]?.[1]).toBeInstanceOf(
      AbortSignal,
    );
  });

  it('does not block durable publication on workspace capacity sampling', async () => {
    const selected = boundaries([event()]);
    const sample = Promise.withResolvers<undefined>();
    const observeWorkspaceCapacity = vi.fn(() => sample.promise);
    const dispatcher = createDispatcher(selected);
    dispatcher.configureRuntimeHooks({ observeWorkspaceCapacity });

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      failed: 0,
      published: 1,
    });
    expect(observeWorkspaceCapacity).toHaveBeenCalledOnce();
    sample.resolve(undefined);
  });

  it('does not change durable publication when capacity sampling fails', async () => {
    const selected = boundaries([event()]);
    const dispatcher = createDispatcher(selected);
    dispatcher.configureRuntimeHooks({
      observeWorkspaceCapacity: vi
        .fn()
        .mockRejectedValue(new Error('metric query failed')),
    });

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      failed: 0,
      published: 1,
    });
  });

  it('bounds pending workspace capacity samples while one sample is in flight', async () => {
    const selected = boundaries([]);
    const batches = Array.from({ length: 11 }, (_, batch) =>
      Array.from({ length: batch === 10 ? 2 : 10 }, (_, offset) =>
        indexedEvent(batch * 10 + offset),
      ),
    );
    vi.mocked(selected.database.claimBatch).mockImplementation(() =>
      Promise.resolve({ events: batches.shift() ?? [], exhaustedCount: 0 }),
    );
    const firstSample = Promise.withResolvers<undefined>();
    const observeWorkspaceCapacity = vi
      .fn<(workspaceId: string) => Promise<void>>()
      .mockImplementationOnce(() => firstSample.promise)
      .mockResolvedValue(undefined);
    const dispatcher = createDispatcher(selected);
    dispatcher.configureRuntimeHooks({ observeWorkspaceCapacity });

    for (let index = 0; index < 11; index += 1)
      await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
        published: index === 10 ? 2 : 10,
      });
    expect(observeWorkspaceCapacity).toHaveBeenCalledOnce();

    firstSample.resolve(undefined);
    await vi.waitFor(() => {
      expect(observeWorkspaceCapacity).toHaveBeenCalledTimes(101);
    });
    expect(observeWorkspaceCapacity).not.toHaveBeenCalledWith(
      indexedEvent(101).workspaceId,
    );
    await dispatcher.close();
  });

  it('evicts the oldest tracked workspace capacity sample at the tracking limit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T12:00:00.000Z'));
    const selected = boundaries([]);
    let claimedEvents: readonly LeasedOutboxEvent[] = [];
    vi.mocked(selected.database.claimBatch).mockImplementation(() =>
      Promise.resolve({ events: claimedEvents, exhaustedCount: 0 }),
    );
    const observeWorkspaceCapacity = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createDispatcher(selected);
    dispatcher.configureRuntimeHooks({ observeWorkspaceCapacity });

    for (let batch = 0; batch < 100; batch += 1) {
      claimedEvents = Array.from({ length: 10 }, (_, offset) =>
        indexedEvent(batch * 10 + offset),
      );
      await dispatcher.dispatchOnce();
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
      expect(observeWorkspaceCapacity).toHaveBeenCalledTimes((batch + 1) * 10);
    }

    claimedEvents = [indexedEvent(1_000)];
    await dispatcher.dispatchOnce();
    await vi.waitFor(() => {
      expect(observeWorkspaceCapacity).toHaveBeenCalledTimes(1_001);
    });

    claimedEvents = [indexedEvent(0), indexedEvent(500)];
    await dispatcher.dispatchOnce();
    await vi.waitFor(() => {
      expect(observeWorkspaceCapacity).toHaveBeenCalledTimes(1_002);
    });
    expect(observeWorkspaceCapacity.mock.calls.at(-1)?.[0]).toBe(
      indexedEvent(0).workspaceId,
    );
    await dispatcher.close();
  });

  it('drains an in-flight workspace capacity sample before closing boundaries', async () => {
    const selected = boundaries([event()]);
    const sample = Promise.withResolvers<undefined>();
    const dispatcher = createDispatcher(selected);
    dispatcher.configureRuntimeHooks({
      observeWorkspaceCapacity: vi.fn(() => sample.promise),
    });
    await dispatcher.dispatchOnce();

    const closing = dispatcher.close();
    await Promise.resolve();
    expect(selected.database.close).not.toHaveBeenCalled();
    expect(selected.producer.close).not.toHaveBeenCalled();

    sample.resolve(undefined);
    await expect(closing).resolves.toBeUndefined();
    expect(selected.database.close).toHaveBeenCalledOnce();
    expect(selected.producer.close).toHaveBeenCalledOnce();
  });

  it('serializes abort-respecting capacity samples at the operation deadline', async () => {
    vi.useFakeTimers();
    const selected = boundaries([indexedEvent(0), indexedEvent(1)]);
    let active = 0;
    let maximumActive = 0;
    const observeWorkspaceCapacity = vi.fn(
      (_workspaceId: string, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          signal.addEventListener(
            'abort',
            () => {
              active -= 1;
              reject(new Error('capacity sample aborted'));
            },
            { once: true },
          );
        }),
    );
    const dispatcher = createDispatcher(
      selected,
      new WorkerDrainState(),
      transportMetrics(),
      readyCapabilities([
        JOB_NAME.advanceWorkflowRun,
        JOB_NAME.reconcileWorkflowTriggers,
      ]),
      100,
    );
    dispatcher.configureRuntimeHooks({ observeWorkspaceCapacity });

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      published: 2,
    });
    await vi.advanceTimersByTimeAsync(210);

    expect(observeWorkspaceCapacity).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
    expect(active).toBe(0);
    await dispatcher.close();
  });

  it('does not replace abort-ignoring capacity work and defers dependency close until it settles', async () => {
    vi.useFakeTimers();
    const selected = boundaries([
      indexedEvent(0),
      indexedEvent(1),
      indexedEvent(2),
    ]);
    const sample = Promise.withResolvers<undefined>();
    let selectedSignal: AbortSignal | undefined;
    const observeWorkspaceCapacity = vi.fn(
      (_workspaceId: string, signal: AbortSignal) => {
        selectedSignal = signal;
        return sample.promise;
      },
    );
    const dispatcher = createDispatcher(
      selected,
      new WorkerDrainState(),
      transportMetrics(),
      readyCapabilities([
        JOB_NAME.advanceWorkflowRun,
        JOB_NAME.reconcileWorkflowTriggers,
      ]),
      100,
    );
    dispatcher.configureRuntimeHooks({ observeWorkspaceCapacity });

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      published: 3,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(selectedSignal?.aborted).toBe(true);
    expect(observeWorkspaceCapacity).toHaveBeenCalledOnce();

    const closeOutcome = dispatcher.close().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    await expect(closeOutcome).resolves.toBeInstanceOf(
      TransportOperationTimeoutError,
    );
    expect(selected.database.close).not.toHaveBeenCalled();
    expect(selected.producer.close).not.toHaveBeenCalled();

    sample.resolve(undefined);
    await vi.waitFor(() => {
      expect(selected.database.close).toHaveBeenCalledOnce();
      expect(selected.producer.close).toHaveBeenCalledOnce();
    });
    expect(observeWorkspaceCapacity).toHaveBeenCalledOnce();
  });

  it('observes an abort-ignoring late capacity rejection before closing dependencies', async () => {
    vi.useFakeTimers();
    const selected = boundaries([event()]);
    const sample = Promise.withResolvers<undefined>();
    const dispatcher = createDispatcher(
      selected,
      new WorkerDrainState(),
      transportMetrics(),
      readyCapabilities([
        JOB_NAME.advanceWorkflowRun,
        JOB_NAME.reconcileWorkflowTriggers,
      ]),
      100,
    );
    dispatcher.configureRuntimeHooks({
      observeWorkspaceCapacity: vi.fn(() => sample.promise),
    });
    await dispatcher.dispatchOnce();

    const closeOutcome = dispatcher.close().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    await closeOutcome;
    sample.reject(new Error('late capacity failure'));

    await vi.waitFor(() => {
      expect(selected.database.close).toHaveBeenCalledOnce();
      expect(selected.producer.close).toHaveBeenCalledOnce();
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
      outcomeUnknown: 0,
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

  it.each([null, 'not-an-object', ['not-an-object']] as const)(
    'rejects an unsupported payload shape before publication (%s)',
    async (payload) => {
      const selected = boundaries([event({ payload })]);

      await expect(createDispatcher(selected).dispatchOnce()).resolves.toEqual(
        expect.objectContaining({ failed: 1, published: 0 }),
      );
      expect(selected.producer.publish).not.toHaveBeenCalled();
      expect(selected.database.releaseOrFail).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: 'outbox.invalid_contract' }),
      );
    },
  );

  it('releases a hostile publication rejection without inspecting or exposing it', async () => {
    const selected = boundaries();
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('hostile prototype trap');
        },
      },
    );
    vi.mocked(selected.producer.publish).mockRejectedValue(hostile);

    await expect(createDispatcher(selected).dispatchOnce()).resolves.toEqual(
      expect.objectContaining({ failed: 1, published: 0 }),
    );
    expect(selected.database.releaseOrFail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'queue.publish_failed' }),
    );
  });

  it('treats a hostile mark rejection as definite failure and releases its exact lease', async () => {
    const selected = boundaries();
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('hostile mark prototype trap');
        },
      },
    );
    vi.mocked(selected.database.markPublished).mockRejectedValue(hostile);

    await expect(createDispatcher(selected).dispatchOnce()).resolves.toEqual(
      expect.objectContaining({ failed: 1, published: 0 }),
    );
    expect(selected.database.releaseOrFail).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'queue.publish_failed',
        id: EVENT_ID,
        leaseToken: LEASE_TOKEN,
      }),
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
      outcomeUnknown: 0,
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

  it('shares one pending close before start and attempts independent closers', async () => {
    const selected = boundaries([]);
    const databaseClose = Promise.withResolvers<undefined>();
    vi.mocked(selected.database.close).mockReturnValue(databaseClose.promise);
    const dispatcher = createDispatcher(selected);

    const first = dispatcher.close();
    const second = dispatcher.close();
    expect(second).toBe(first);
    await vi.waitFor(() => {
      expect(selected.database.close).toHaveBeenCalledOnce();
      expect(selected.producer.close).toHaveBeenCalledOnce();
    });

    databaseClose.resolve(undefined);
    await expect(first).resolves.toBeUndefined();
  });

  it('drains concurrent direct claims before closing either dependency', async () => {
    const selected = boundaries([]);
    const firstClaim = Promise.withResolvers<{
      events: readonly LeasedOutboxEvent[];
      exhaustedCount: number;
    }>();
    const secondClaim = Promise.withResolvers<{
      events: readonly LeasedOutboxEvent[];
      exhaustedCount: number;
    }>();
    vi.mocked(selected.database.claimBatch)
      .mockReturnValueOnce(firstClaim.promise)
      .mockReturnValueOnce(secondClaim.promise);
    const dispatcher = createDispatcher(selected);

    const firstDispatch = dispatcher.dispatchOnce();
    const secondDispatch = dispatcher.dispatchOnce();
    const closing = dispatcher.close();
    await Promise.resolve();
    expect(selected.database.close).not.toHaveBeenCalled();
    expect(selected.producer.close).not.toHaveBeenCalled();

    firstClaim.resolve({ events: [], exhaustedCount: 0 });
    await firstDispatch;
    expect(selected.database.close).not.toHaveBeenCalled();
    secondClaim.resolve({ events: [], exhaustedCount: 0 });
    await secondDispatch;
    await closing;
    expect(selected.database.close).toHaveBeenCalledOnce();
    expect(selected.producer.close).toHaveBeenCalledOnce();
  });

  it('finishes an admitted publication and mark before dependency close', async () => {
    const selected = boundaries([event()]);
    const publication =
      Promise.withResolvers<Awaited<ReturnType<QueueProducer['publish']>>>();
    const mark = Promise.withResolvers<boolean>();
    vi.mocked(selected.producer.publish).mockReturnValue(publication.promise);
    vi.mocked(selected.database.markPublished).mockReturnValue(mark.promise);
    const dispatcher = createDispatcher(selected);

    const dispatch = dispatcher.dispatchOnce();
    await vi.waitFor(() => {
      expect(selected.producer.publish).toHaveBeenCalledOnce();
    });
    const closing = dispatcher.close();
    publication.resolve({
      jobId: `outbox-${EVENT_ID}`,
      jobName: JOB_NAME.advanceWorkflowRun,
      outcome: 'published',
      queueName: 'workflow-coordinator',
    });
    await vi.waitFor(() => {
      expect(selected.database.markPublished).toHaveBeenCalledOnce();
    });
    expect(selected.database.close).not.toHaveBeenCalled();

    mark.resolve(true);
    await expect(dispatch).resolves.toMatchObject({ published: 1 });
    await closing;
    expect(selected.database.close).toHaveBeenCalledOnce();
    expect(selected.producer.close).toHaveBeenCalledOnce();
  });

  it('waits for an admitted failed publication release before dependency close', async () => {
    const selected = boundaries([event()]);
    const release = Promise.withResolvers<ReleaseOutboxResult>();
    vi.mocked(selected.producer.publish).mockRejectedValue(
      new Error('Redis unavailable'),
    );
    vi.mocked(selected.database.releaseOrFail).mockReturnValue(release.promise);
    const dispatcher = createDispatcher(selected);

    const dispatch = dispatcher.dispatchOnce();
    await vi.waitFor(() => {
      expect(selected.database.releaseOrFail).toHaveBeenCalledOnce();
    });
    const closing = dispatcher.close();
    await Promise.resolve();
    expect(selected.database.close).not.toHaveBeenCalled();

    release.resolve('retry_scheduled');
    await expect(dispatch).resolves.toMatchObject({ failed: 1 });
    await closing;
    expect(selected.database.close).toHaveBeenCalledOnce();
    expect(selected.producer.close).toHaveBeenCalledOnce();
  });

  it('waits for admitted queue and backlog observations before dependency close', async () => {
    const selected = boundaries([event()]);
    const queueObservation =
      Promise.withResolvers<Awaited<ReturnType<QueueProducer['observe']>>>();
    const backlogObservation = Promise.withResolvers<{
      backlog: number;
      oldestAgeSeconds?: number;
    }>();
    vi.mocked(selected.producer.observe).mockReturnValue(
      queueObservation.promise,
    );
    vi.mocked(selected.database.observeBacklog).mockReturnValue(
      backlogObservation.promise,
    );
    const dispatcher = createDispatcher(selected);

    const dispatch = dispatcher.dispatchOnce();
    await vi.waitFor(() => {
      expect(selected.producer.observe).toHaveBeenCalledOnce();
      expect(selected.database.observeBacklog).toHaveBeenCalledOnce();
    });
    const closing = dispatcher.close();
    await Promise.resolve();
    expect(selected.database.close).not.toHaveBeenCalled();

    queueObservation.resolve([]);
    backlogObservation.resolve({ backlog: 0 });
    await dispatch;
    await closing;
    expect(selected.database.close).toHaveBeenCalledOnce();
    expect(selected.producer.close).toHaveBeenCalledOnce();
  });

  it('revokes readiness that completes after close begins', async () => {
    const selected = boundaries([]);
    const databaseReady = Promise.withResolvers<undefined>();
    const producerReady = Promise.withResolvers<undefined>();
    const consumerReady = Promise.withResolvers<undefined>();
    vi.mocked(selected.database.checkReadiness).mockReturnValue(
      databaseReady.promise,
    );
    vi.mocked(selected.producer.waitUntilReady).mockReturnValue(
      producerReady.promise,
    );
    const capabilities = createDispatchConsumerCapabilityRegistry([
      {
        consumer: {
          isReady: () => true,
          waitUntilReady: () => consumerReady.promise,
        },
        jobName: JOB_NAME.advanceWorkflowRun,
      },
      {
        consumer: {
          isReady: () => true,
          waitUntilReady: () => Promise.resolve(),
        },
        jobName: JOB_NAME.reconcileWorkflowTriggers,
      },
    ]);
    const dispatcher = createDispatcher(
      selected,
      new WorkerDrainState(),
      transportMetrics(),
      capabilities,
    );

    const readiness = dispatcher.checkReadiness();
    await dispatcher.close();
    databaseReady.resolve(undefined);
    producerReady.resolve(undefined);
    consumerReady.resolve(undefined);
    await expect(readiness).rejects.toThrow('closed');
  });

  it('revokes readiness that completes after drain begins', async () => {
    const selected = boundaries([]);
    const databaseReady = Promise.withResolvers<undefined>();
    vi.mocked(selected.database.checkReadiness).mockReturnValue(
      databaseReady.promise,
    );
    const drain = new WorkerDrainState();
    const dispatcher = createDispatcher(selected, drain);

    const readiness = dispatcher.checkReadiness();
    drain.beginDrain();
    databaseReady.resolve(undefined);

    await expect(readiness).rejects.toThrow('draining');
    await dispatcher.close();
  });

  it('wakes the polling delay during close without waiting a full interval', async () => {
    vi.useFakeTimers();
    const selected = boundaries([]);
    const dispatcher = createDispatcher(selected);
    dispatcher.start();
    await vi.waitFor(() => {
      expect(selected.database.claimBatch).toHaveBeenCalledOnce();
    });

    await expect(dispatcher.close()).resolves.toBeUndefined();
    expect(selected.database.claimBatch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a late unknown publication and marks with the original token', async () => {
    const selected = boundaries([event()]);
    const settlement = Promise.withResolvers<'failed' | 'published'>();
    vi.mocked(selected.producer.publish).mockResolvedValue({
      jobId: `outbox-${EVENT_ID}`,
      jobName: JOB_NAME.advanceWorkflowRun,
      outcome: 'outcome_unknown',
      queueName: 'workflow-coordinator',
      settlement: settlement.promise,
    });
    const dispatcher = createDispatcher(selected);

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      outcomeUnknown: 1,
    });
    const closing = dispatcher.close();
    await Promise.resolve();
    expect(selected.database.close).not.toHaveBeenCalled();

    settlement.resolve('published');
    await closing;
    expect(selected.database.markPublished).toHaveBeenCalledWith(
      EVENT_ID,
      LEASE_TOKEN,
    );
    expect(selected.database.releaseOrFail).not.toHaveBeenCalled();
  });

  it('aggregates synchronous database and rejected producer close failures', async () => {
    const selected = boundaries([]);
    const databaseFailure = new Error('database close failed');
    const producerFailure = new Error('producer close failed');
    vi.mocked(selected.database.close).mockImplementation(() => {
      throw databaseFailure;
    });
    vi.mocked(selected.producer.close).mockRejectedValue(producerFailure);

    const failure = await createDispatcher(selected)
      .close()
      .catch((error: unknown) => error);

    expect((failure as AggregateError).errors).toEqual([
      databaseFailure,
      producerFailure,
    ]);
    expect(selected.database.close).toHaveBeenCalledOnce();
    expect(selected.producer.close).toHaveBeenCalledOnce();
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
