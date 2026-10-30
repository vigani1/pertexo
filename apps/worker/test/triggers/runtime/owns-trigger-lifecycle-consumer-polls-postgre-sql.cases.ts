import { JOB_NAME, QUEUE_NAME } from '@pertexo/queue';
import { expect, it, vi } from 'vitest';

import { dependencies, options } from './fixture.js';
import { testTriggerRuntime } from '../../support/runtime-factories.js';

export function registerOwnsTriggerLifecycleConsumerPollsPostgreSQL(): void {
  it('owns the trigger lifecycle consumer and polls PostgreSQL without overlap', async () => {
    const selected = dependencies();
    const runtime = await testTriggerRuntime(options, {
      ...selected,
      checkpointFactory: () => ({ checkpoint: {} }),
    });

    expect(selected.consumerOptions()).toMatchObject({
      queueName: QUEUE_NAME.triggerLifecycle,
      redisUrl: options.redisUrl,
    });
    await vi.waitFor(() => {
      expect(selected.scanner.scanDue).toHaveBeenCalled();
    });
    expect(selected.scanner.scanDue).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseOwner: options.leaseOwner,
        limit: options.batchSize,
        leaseSeconds: options.leaseDurationSeconds,
        onTimeWindowSeconds: options.onTimeWindowSeconds,
        checkpointFactory: expect.any(Function) as unknown,
        signal: expect.any(AbortSignal) as unknown,
      }),
    );
    expect(selected.consumerOptions()?.traceRunner).toBeDefined();
    expect(selected.telemetry.scanCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ maxLagSeconds: 0 }),
      expect.any(Number) as unknown,
    );
    await runtime.close();
  });

  it('recovers a transient PostgreSQL scan failure and makes no claims after drain', async () => {
    vi.useFakeTimers();
    try {
      const selected = dependencies();
      selected.telemetry.scanCompleted.mockImplementation(() => {
        throw new Error('scan completion metrics unavailable');
      });
      selected.telemetry.scanFailed.mockImplementation(() => {
        throw new Error('scan failure metrics unavailable');
      });
      vi.mocked(selected.scanner.scanDue)
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockResolvedValue({
          claimed: 1,
          accepted: 0,
          skipped: 1,
          paused: 0,
          deferred: 0,
          maxLagSeconds: 3,
        });
      const runtime = await testTriggerRuntime(options, {
        ...selected,
        checkpointFactory: () => ({ checkpoint: {} }),
      });

      await vi.waitFor(() =>
        expect(runtime.checkReadiness()).rejects.toThrow(/latest scan/u),
      );
      expect(selected.logger.error).toHaveBeenCalledWith(
        'trigger.scan_failed',
        { safeErrorCode: 'trigger.scan_failed' },
        expect.any(Error) as unknown,
      );
      expect(selected.telemetry.scanFailed).toHaveBeenCalledWith(
        expect.any(Number) as unknown,
      );

      await vi.waitFor(() => {
        expect(
          vi.mocked(selected.scanner.scanDue).mock.calls.length,
        ).toBeGreaterThanOrEqual(2);
      });
      await expect(runtime.checkReadiness()).resolves.toBeUndefined();
      await runtime.close();
      const callsAfterClose = vi.mocked(selected.scanner.scanDue).mock.calls
        .length;
      await vi.advanceTimersByTimeAsync(40);
      expect(selected.scanner.scanDue).toHaveBeenCalledTimes(callsAfterClose);
      expect(selected.consumer.close).toHaveBeenCalledOnce();
      expect(selected.scanner.close).toHaveBeenCalledOnce();
      expect(selected.reconciliation.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes only reconciliation jobs and closes constructed stores after consumer setup fails', async () => {
    const selected = dependencies();
    const startupFailure = new Error('redis schema incompatible');

    await expect(
      testTriggerRuntime(options, {
        ...selected,
        checkpointFactory: () => ({ checkpoint: {} }),
        consumerFactory: () => {
          throw startupFailure;
        },
      }),
    ).rejects.toBe(startupFailure);
    expect(selected.scanner.close).toHaveBeenCalledOnce();
    expect(selected.reconciliation.close).toHaveBeenCalledOnce();
  });

  it('uses the public queue handler for reconciliation deliveries', async () => {
    const selected = dependencies();
    const runtime = await testTriggerRuntime(options, {
      ...selected,
      checkpointFactory: () => ({ checkpoint: {} }),
    });

    await expect(
      selected.consumerOptions()?.handler(
        {
          name: JOB_NAME.reconcileWorkflowTriggers,
          data: {
            workspaceId: '11111111-1111-4111-8111-111111111111',
            workflowId: '22222222-2222-4222-8222-222222222222',
            publishedVersionId: '33333333-3333-4333-8333-333333333333',
            outboxEventId: '44444444-4444-4444-8444-444444444444',
          },
          transport: {
            attemptsMade: 0,
            jobId: 'outbox-44444444-4444-4444-8444-444444444444',
          },
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toBeUndefined();
    expect(selected.telemetry.reconciliationCompleted).toHaveBeenCalledWith(
      'succeeded',
    );
    await runtime.close();
  });

  it('rejects jobs from outside the trigger lifecycle contract', async () => {
    const selected = dependencies();
    const runtime = await testTriggerRuntime(options, {
      ...selected,
      checkpointFactory: () => ({ checkpoint: {} }),
    });

    await expect(
      selected.consumerOptions()?.handler(
        {
          name: JOB_NAME.advanceWorkflowRun,
          data: {
            workspaceId: '11111111-1111-4111-8111-111111111111',
            runId: '22222222-2222-4222-8222-222222222222',
            outboxEventId: '44444444-4444-4444-8444-444444444444',
          },
          transport: {
            attemptsMade: 0,
            jobId: 'outbox-44444444-4444-4444-8444-444444444444',
          },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ name: 'InvalidQueueDeliveryError' });
    await runtime.close();
  });
}
