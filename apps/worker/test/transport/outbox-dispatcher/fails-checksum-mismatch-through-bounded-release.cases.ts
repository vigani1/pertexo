import { transportMetrics } from '../../support/transport/metrics.js';
import type {
  LeasedOutboxEvent,
  ReleaseOutboxResult,
} from '@pertexo/core/testing';

import { JOB_NAME, type QueueProducer } from '@pertexo/queue';
import { expect, it, vi } from 'vitest';

import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import {
  EVENT_ID,
  LEASE_TOKEN,
  event,
  boundaries,
  createDispatcher,
} from './fixture.js';

export function registerFailsChecksumMismatchThroughBoundedRelease(): void {
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
}
