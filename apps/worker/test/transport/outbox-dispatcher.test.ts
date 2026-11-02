import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanAppsWorkerTestTransportOutboxDispatcherOutboxDispatcherFixture,
  EVENT_ID,
  LEASE_TOKEN,
  WORKSPACE_ID,
  RUN_ID,
  event,
  boundaries,
  createDispatcher,
  indexedEvent,
  checksum,
} from './outbox-dispatcher/fixture.js';
import { transportMetrics } from '../support/transport/metrics.js';
import { JOB_NAME, type QueueJob, type QueueProducer } from '@pertexo/queue';
import { OutboxDispatcher } from '../../src/transport/outbox/dispatch/runtime.js';
import { WorkerDrainState } from '../../src/runtime/shutdown/drain-state.js';
import type {
  LeasedOutboxEvent,
  ReleaseOutboxResult,
} from '@pertexo/core/testing';
import { TransportOperationTimeoutError } from '../../src/transport/outbox/operation-deadline.js';
import { OutboxPayloadChecksumError } from '../../src/transport/outbox/dispatch/errors.js';

describe('outbox dispatcher', () => {
  afterEach(
    cleanAppsWorkerTestTransportOutboxDispatcherOutboxDispatcherFixture,
  );
  it('rejects duplicate job allowlists at construction before storage or queue work', () => {
    const selected = boundaries([]);
    expect(
      () =>
        new OutboxDispatcher(selected.database, selected.producer, {
          drainState: new WorkerDrainState(),
          options: {
            batchSize: 10,
            jobNames: [
              JOB_NAME.advanceWorkflowRun,
              JOB_NAME.advanceWorkflowRun,
            ],
            leaseDurationMillis: 30_000,
            leaseOwner: 'worker-a',
            retryDelayMillis: 1_000,
          },
        }),
    ).toThrow('Outbox job allowlist must be unique');
    expect(selected.database.claimBatch).not.toHaveBeenCalled();
    expect(selected.database.observeBacklog).not.toHaveBeenCalled();
    expect(selected.producer.publish).not.toHaveBeenCalled();
  });

  it('holds every row when the worker consumes no job kind', async () => {
    const selected = boundaries([event()]);
    const dispatcher = new OutboxDispatcher(
      selected.database,
      selected.producer,
      {
        drainState: new WorkerDrainState(),
        options: {
          batchSize: 10,
          jobNames: [],
          leaseDurationMillis: 30_000,
          leaseOwner: 'worker-a',
          pollIntervalMillis: 10,
          retryDelayMillis: 1_000,
        },
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

  it('publishes a validated queue contract and conditionally marks its lease', async () => {
    const selected = boundaries();
    const metrics = transportMetrics();
    const dispatcher = createDispatcher({
      boundaries: selected,
      drainState: new WorkerDrainState(),
      metrics: metrics,
    });

    await expect(dispatcher.dispatchOnce()).resolves.toEqual({
      claimed: 1,
      failed: 0,
      outcomeUnknown: 0,
      published: 1,
      stale: 0,
    });
    expect(selected.producer.publish).toHaveBeenCalledWith(
      {
        name: JOB_NAME.advanceWorkflowRun,
        data: {
          outboxEventId: EVENT_ID,
          runId: RUN_ID,
          workspaceId: WORKSPACE_ID,
        },
      } satisfies QueueJob,
      0,
    );
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
    const dispatcher = createDispatcher({ boundaries: selected });

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
      createDispatcher({
        boundaries: selected,
        drainState: new WorkerDrainState(),
        metrics: metrics,
      }).dispatchOnce(),
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
    const dispatcher = createDispatcher({ boundaries: selected });

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
    const dispatcher = createDispatcher({ boundaries: selected });

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
      const dispatcher = createDispatcher({
        boundaries: selected,
        drainState: new WorkerDrainState(),
        metrics: transportMetrics(),
        operationTimeoutMillis: 100,
      });

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

    await createDispatcher({
      boundaries: selected,
      drainState: new WorkerDrainState(),
      metrics: metrics,
    }).dispatchOnce();

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
    const dispatcher = createDispatcher({ boundaries: selected });
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
    const dispatcher = createDispatcher({ boundaries: selected });
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
    const dispatcher = createDispatcher({ boundaries: selected });
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
      Promise.resolve({ events: batches.shift() ?? [] }),
    );
    const firstSample = Promise.withResolvers<undefined>();
    const observeWorkspaceCapacity = vi
      .fn<(workspaceId: string) => Promise<void>>()
      .mockImplementationOnce(() => firstSample.promise)
      .mockResolvedValue(undefined);
    const dispatcher = createDispatcher({ boundaries: selected });
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
      Promise.resolve({ events: claimedEvents }),
    );
    const observeWorkspaceCapacity = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createDispatcher({ boundaries: selected });
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
    const dispatcher = createDispatcher({ boundaries: selected });
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
    const dispatcher = createDispatcher({
      boundaries: selected,
      drainState: new WorkerDrainState(),
      metrics: transportMetrics(),
      operationTimeoutMillis: 100,
    });
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
    const dispatcher = createDispatcher({
      boundaries: selected,
      drainState: new WorkerDrainState(),
      metrics: transportMetrics(),
      operationTimeoutMillis: 100,
    });
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
    const dispatcher = createDispatcher({
      boundaries: selected,
      drainState: new WorkerDrainState(),
      metrics: transportMetrics(),
      operationTimeoutMillis: 100,
    });
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

  it('records retry claims, stale leases, and failed publications without dynamic labels', async () => {
    const retried = boundaries([event({ publishAttempts: 2 })]);
    vi.mocked(retried.database.markPublished).mockResolvedValue(false);
    const staleMetrics = transportMetrics();

    await createDispatcher({
      boundaries: retried,
      drainState: new WorkerDrainState(),
      metrics: staleMetrics,
    }).dispatchOnce();

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

    await createDispatcher({
      boundaries: exhausted,
      drainState: new WorkerDrainState(),
      metrics: exhaustedMetrics,
    }).dispatchOnce();

    expect(exhaustedMetrics.recordOutboxPublish).toHaveBeenCalledWith({
      errorClass: 'redis',
      jobName: JOB_NAME.advanceWorkflowRun,
      outcome: 'failed',
      queueName: 'workflow-coordinator',
    });
    expect(exhaustedMetrics.recordOutboxLeaseEvent).toHaveBeenCalledWith(
      'publication_failed',
    );
  });

  it('does not let a metrics failure alter durable dispatch', async () => {
    const selected = boundaries();
    const metrics = transportMetrics();
    vi.mocked(metrics.recordOutboxPublish).mockImplementation(() => {
      throw new Error('metrics unavailable');
    });

    await expect(
      createDispatcher({
        boundaries: selected,
        drainState: new WorkerDrainState(),
        metrics: metrics,
      }).dispatchOnce(),
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

    await expect(
      createDispatcher({ boundaries: selected }).dispatchOnce(),
    ).resolves.toEqual(expect.objectContaining({ published: 1 }));
  });

  it('fails a checksum mismatch through the bounded release seam without publishing', async () => {
    const selected = boundaries([event({ payloadChecksum: '0'.repeat(64) })]);
    const metrics = transportMetrics();
    const dispatcher = createDispatcher({
      boundaries: selected,
      drainState: new WorkerDrainState(),
      metrics: metrics,
    });

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
      }),
    );
  });

  it('releases invalid queue contracts and Redis failures with stable error codes', async () => {
    const invalid = boundaries([event({ payload: { graph: 'not-an-id' } })]);
    const redisFailure = boundaries();
    vi.mocked(redisFailure.producer.publish).mockRejectedValue(
      new Error('redis unavailable'),
    );

    await createDispatcher({ boundaries: invalid }).dispatchOnce();
    await createDispatcher({ boundaries: redisFailure }).dispatchOnce();

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

      await expect(
        createDispatcher({ boundaries: selected }).dispatchOnce(),
      ).resolves.toEqual(expect.objectContaining({ failed: 1, published: 0 }));
      expect(selected.producer.publish).not.toHaveBeenCalled();
      expect(selected.database.releaseOrFail).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: 'outbox.invalid_contract' }),
      );
    },
  );

  it('stops claiming as soon as drain begins', async () => {
    const selected = boundaries();
    const drainState = new WorkerDrainState();
    const dispatcher = createDispatcher({
      boundaries: selected,
      drainState: drainState,
    });
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
    const dispatcher = createDispatcher({ boundaries: selected });

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
    const dispatcher = createDispatcher({ boundaries: selected });

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
    }>();
    const secondClaim = Promise.withResolvers<{
      events: readonly LeasedOutboxEvent[];
    }>();
    vi.mocked(selected.database.claimBatch)
      .mockReturnValueOnce(firstClaim.promise)
      .mockReturnValueOnce(secondClaim.promise);
    const dispatcher = createDispatcher({ boundaries: selected });

    const firstDispatch = dispatcher.dispatchOnce();
    const secondDispatch = dispatcher.dispatchOnce();
    const closing = dispatcher.close();
    await Promise.resolve();
    expect(selected.database.close).not.toHaveBeenCalled();
    expect(selected.producer.close).not.toHaveBeenCalled();

    firstClaim.resolve({ events: [] });
    await firstDispatch;
    expect(selected.database.close).not.toHaveBeenCalled();
    secondClaim.resolve({ events: [] });
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
    const dispatcher = createDispatcher({ boundaries: selected });

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
    const dispatcher = createDispatcher({ boundaries: selected });

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
    const dispatcher = createDispatcher({ boundaries: selected });

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
    vi.mocked(selected.database.checkReadiness).mockReturnValue(
      databaseReady.promise,
    );
    vi.mocked(selected.producer.waitUntilReady).mockReturnValue(
      producerReady.promise,
    );
    const dispatcher = createDispatcher({ boundaries: selected });

    const readiness = dispatcher.checkReadiness();
    await dispatcher.close();
    databaseReady.resolve(undefined);
    producerReady.resolve(undefined);
    await expect(readiness).rejects.toThrow('closed');
  });

  it('revokes readiness that completes after drain begins', async () => {
    const selected = boundaries([]);
    const databaseReady = Promise.withResolvers<undefined>();
    vi.mocked(selected.database.checkReadiness).mockReturnValue(
      databaseReady.promise,
    );
    const drain = new WorkerDrainState();
    const dispatcher = createDispatcher({
      boundaries: selected,
      drainState: drain,
    });

    const readiness = dispatcher.checkReadiness();
    drain.beginDrain();
    databaseReady.resolve(undefined);

    await expect(readiness).rejects.toThrow('draining');
    await dispatcher.close();
  });

  it('wakes the polling delay during close without waiting a full interval', async () => {
    vi.useFakeTimers();
    const selected = boundaries([]);
    const dispatcher = createDispatcher({ boundaries: selected });
    dispatcher.start();
    await vi.waitFor(() => {
      expect(selected.database.claimBatch).toHaveBeenCalledOnce();
    });

    await expect(dispatcher.close()).resolves.toBeUndefined();
    expect(selected.database.claimBatch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispatches follow-up work promptly after a publication', async () => {
    vi.useFakeTimers();
    const selected = boundaries([]);
    vi.mocked(selected.database.claimBatch)
      .mockResolvedValueOnce({ events: [event()] })
      .mockResolvedValueOnce({ events: [indexedEvent(2)] });
    const dispatcher = createDispatcher({
      boundaries: selected,
      drainState: new WorkerDrainState(),
      metrics: transportMetrics(),
      operationTimeoutMillis: 5_000,
      pollIntervalMillis: 250,
    });
    try {
      dispatcher.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(selected.producer.publish).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(24);
      expect(selected.database.claimBatch).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(selected.producer.publish).toHaveBeenCalledTimes(2);
    } finally {
      await dispatcher.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stays quick for a second after work, then backs off to the idle interval', async () => {
    vi.useFakeTimers();
    const selected = boundaries([]);
    vi.mocked(selected.database.claimBatch).mockResolvedValueOnce({
      events: [event()],
    });
    const dispatcher = createDispatcher({
      boundaries: selected,
      drainState: new WorkerDrainState(),
      metrics: transportMetrics(),
      operationTimeoutMillis: 5_000,
      pollIntervalMillis: 250,
    });
    try {
      dispatcher.start();
      await vi.advanceTimersByTimeAsync(0);
      let claims = 1;
      // A run's next step arrives within this window, so it isn't left
      // waiting for a backed-off round.
      const quickRounds = Array.from({ length: 40 }, () => 25);
      for (const interval of [...quickRounds, 50, 100, 200, 250, 250]) {
        await vi.advanceTimersByTimeAsync(interval - 1);
        expect(selected.database.claimBatch).toHaveBeenCalledTimes(claims);
        await vi.advanceTimersByTimeAsync(1);
        claims += 1;
        expect(selected.database.claimBatch).toHaveBeenCalledTimes(claims);
      }
    } finally {
      await dispatcher.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the configured interval when initially idle', async () => {
    vi.useFakeTimers();
    const selected = boundaries([]);
    const dispatcher = createDispatcher({
      boundaries: selected,
      drainState: new WorkerDrainState(),
      metrics: transportMetrics(),
      operationTimeoutMillis: 5_000,
      pollIntervalMillis: 250,
    });
    try {
      dispatcher.start();
      await vi.advanceTimersByTimeAsync(249);
      expect(selected.database.claimBatch).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(selected.database.claimBatch).toHaveBeenCalledTimes(2);
    } finally {
      await dispatcher.close();
    }
  });

  it.each([
    { outcome: 'failed', interval: 250 },
    { outcome: 'outcome_unknown', interval: 25 },
  ] as const)(
    'polls after $interval ms when publication is $outcome',
    async ({ outcome, interval }) => {
      vi.useFakeTimers();
      const selected = boundaries([]);
      vi.mocked(selected.database.claimBatch).mockResolvedValueOnce({
        events: [event()],
      });
      if (outcome === 'failed') {
        vi.mocked(selected.producer.publish).mockRejectedValueOnce(
          new Error('redis unavailable'),
        );
      } else {
        vi.mocked(selected.producer.publish).mockResolvedValueOnce({
          jobId: `outbox-${EVENT_ID}`,
          jobName: JOB_NAME.advanceWorkflowRun,
          outcome: 'outcome_unknown',
          queueName: 'workflow-coordinator',
          settlement: Promise.resolve('published'),
        });
      }
      const dispatcher = createDispatcher({
        boundaries: selected,
        drainState: new WorkerDrainState(),
        metrics: transportMetrics(),
        operationTimeoutMillis: 5_000,
        pollIntervalMillis: 250,
      });
      try {
        dispatcher.start();
        await vi.advanceTimersByTimeAsync(interval - 1);
        expect(selected.database.claimBatch).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        expect(selected.database.claimBatch).toHaveBeenCalledTimes(2);
      } finally {
        await dispatcher.close();
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('restores the idle interval after a failed claim during activity', async () => {
    vi.useFakeTimers();
    const selected = boundaries([]);
    vi.mocked(selected.database.claimBatch)
      .mockResolvedValueOnce({ events: [event()] })
      .mockRejectedValueOnce(new Error('postgres restarted'));
    const dispatcher = createDispatcher({
      boundaries: selected,
      drainState: new WorkerDrainState(),
      metrics: transportMetrics(),
      operationTimeoutMillis: 5_000,
      pollIntervalMillis: 250,
    });
    try {
      dispatcher.start();
      await vi.advanceTimersByTimeAsync(25);
      expect(selected.database.claimBatch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(249);
      expect(selected.database.claimBatch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(selected.database.claimBatch).toHaveBeenCalledTimes(3);
    } finally {
      await dispatcher.close();
    }
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
    const dispatcher = createDispatcher({ boundaries: selected });

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

    const failure = await createDispatcher({ boundaries: selected })
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
      .mockResolvedValue({ events: [] });
    const drainState = new WorkerDrainState();
    const dispatcher = createDispatcher({
      boundaries: selected,
      drainState: drainState,
    });

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
    const failingDrain = {
      canAcceptWork: vi
        .fn()
        .mockReturnValueOnce(true)
        .mockImplementation(() => {
          throw new Error('loop failed');
        }),
    };
    const drainState = failingDrain as unknown as WorkerDrainState;
    const dispatcher = createDispatcher({
      boundaries: selected,
      drainState: drainState,
    });
    dispatcher.start();
    await vi.waitFor(() => {
      expect(failingDrain.canAcceptWork).toHaveBeenCalledTimes(2);
    });

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
