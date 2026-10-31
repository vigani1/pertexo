import { transportMetrics } from '../../support/transport/metrics.js';
import { JOB_NAME } from '@pertexo/queue';
import { expect, it, vi } from 'vitest';

import { TransportOperationTimeoutError } from '../../../src/transport/outbox/operation-deadline.js';
import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import {
  RUN_ID,
  indexedEvent,
  checksum,
  event,
  boundaries,
  createDispatcher,
} from './fixture.js';

export function registerSerializesAbortRespectingCapacitySamplesAt(): void {
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
}
