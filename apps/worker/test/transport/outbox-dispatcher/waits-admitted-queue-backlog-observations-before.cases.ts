import { transportMetrics } from '../../support/transport/metrics.js';
import { JOB_NAME, type QueueProducer } from '@pertexo/queue';
import { expect, it, vi } from 'vitest';

import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import {
  EVENT_ID,
  indexedEvent,
  event,
  boundaries,
  createDispatcher,
} from './fixture.js';

export function registerWaitsAdmittedQueueBacklogObservationsBefore(): void {
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
}
