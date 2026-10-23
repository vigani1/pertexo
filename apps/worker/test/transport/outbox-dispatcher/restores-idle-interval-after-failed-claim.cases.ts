import { JOB_NAME } from '@pertexo/queue';
import { expect, it, vi } from 'vitest';

import { OutboxPayloadChecksumError } from '../../../src/transport/outbox/dispatch/errors.js';

import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import {
  EVENT_ID,
  LEASE_TOKEN,
  RUN_ID,
  event,
  boundaries,
  transportMetrics,
  createDispatcher,
} from './fixture.js';

export function registerRestoresIdleIntervalAfterFailedClaim(): void {
  it('restores the idle interval after a failed claim during activity', async () => {
    vi.useFakeTimers();
    const selected = boundaries([]);
    vi.mocked(selected.database.claimBatch)
      .mockResolvedValueOnce({ events: [event()], exhaustedCount: 0 })
      .mockRejectedValueOnce(new Error('postgres restarted'));
    const dispatcher = createDispatcher(
      selected,
      new WorkerDrainState(),
      transportMetrics(),
      5_000,
      250,
    );
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
}
