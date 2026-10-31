import { transportMetrics } from '../../support/transport/metrics.js';
import { JOB_NAME, type QueueJob } from '@pertexo/queue';
import { expect, it, vi } from 'vitest';
import { OutboxDispatcher } from '../../../src/transport/outbox/dispatch/runtime.js';

import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import {
  EVENT_ID,
  LEASE_TOKEN,
  WORKSPACE_ID,
  RUN_ID,
  event,
  boundaries,
  createDispatcher,
} from './fixture.js';

export function registerHoldsEveryRowWorkerConsumesNo(): void {
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
}
