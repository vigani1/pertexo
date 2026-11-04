import { describe, expect, it, vi } from 'vitest';
import type { ScheduleTriggerScanner } from '@pertexo/core/testing';
import type { TriggerCompositionFactories } from '../../src/triggers/trigger.runtime.js';
import { dependencies, options } from './trigger-runtime.fixture.js';
import { testTriggerRuntime } from '../support/runtime-factories.js';
import { JOB_NAME, QUEUE_NAME } from '@pertexo/queue';

describe('trigger runtime', () => {
  it.each([
    ['telemetry', []],
    ['traceRunner', []],
    ['reconciliation', []],
    ['scanner', ['reconciliation']],
    ['coordination', ['reconciliation', 'scanner']],
    ['consumer', ['reconciliation', 'scanner', 'coordination']],
  ] as const)(
    'rolls back owners acquired before %s construction fails',
    async (failedStage, expectedClosed) => {
      const failure = new Error(`${failedStage} failed`);
      const closed: string[] = [];
      const reconciliation = {
        close: vi.fn(() => {
          closed.push('reconciliation');
          return Promise.resolve();
        }),
        reconcile: vi.fn(),
        recordFailure: vi.fn(),
      };
      const scanner = {
        close: vi.fn(() => {
          closed.push('scanner');
          return Promise.resolve();
        }),
        scanDue: vi.fn(),
      };
      const acquire = <T>(stage: string, value: T): T => {
        if (stage === failedStage) throw failure;
        return value;
      };
      const factories = {
        coordination: vi.fn(() =>
          acquire('coordination', {
            close: vi.fn(() => {
              closed.push('coordination');
              return Promise.resolve();
            }),
            scanDue: vi.fn(),
          }),
        ),
        consumer: vi.fn(() =>
          acquire('consumer', {
            close: vi.fn(),
            isReady: vi.fn(),
            waitUntilReady: vi.fn(),
          }),
        ),
        reconciliation: vi.fn(() => acquire('reconciliation', reconciliation)),
        scanner: vi.fn(() => acquire('scanner', scanner)),
        telemetry: vi.fn(() => acquire('telemetry', {})),
        traceRunner: vi.fn(() => acquire('traceRunner', {})),
      } as unknown as TriggerCompositionFactories;

      await expect(
        testTriggerRuntime(
          options,
          {
            checkpointFactory: () => ({
              checkpoint: {},
            }),
          },
          factories,
        ),
      ).rejects.toBe(failure);
      expect(new Set(closed)).toEqual(new Set(expectedClosed));
      expect(closed).toHaveLength(expectedClosed.length);
    },
  );

  it('waits for its first scan, never overlaps scans, and stays closed', async () => {
    vi.useFakeTimers();
    try {
      const selected = dependencies();
      const firstScan = Promise.withResolvers<{
        claimed: number;
        accepted: number;
        skipped: number;
        paused: number;
        deferred: number;
        maxLagSeconds: number;
      }>();
      let active = 0;
      let maximumActive = 0;
      vi.mocked(selected.scanner.scanDue).mockImplementation(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          return await firstScan.promise;
        } finally {
          active -= 1;
        }
      });
      const runtime = await testTriggerRuntime(
        { ...options, pollIntervalMillis: 10 },
        {
          ...selected,
          checkpointFactory: () => ({ checkpoint: {} }),
        },
      );
      let readinessSettled = false;
      const readiness = runtime.checkReadiness().finally(() => {
        readinessSettled = true;
      });
      await vi.waitFor(() => {
        expect(selected.scanner.scanDue).toHaveBeenCalledOnce();
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(readinessSettled).toBe(false);
      expect(selected.scanner.scanDue).toHaveBeenCalledOnce();
      expect(maximumActive).toBe(1);

      firstScan.resolve({
        claimed: 0,
        accepted: 0,
        skipped: 0,
        paused: 0,
        deferred: 0,
        maxLagSeconds: 0,
      });
      await readiness;
      await runtime.close();
      await expect(runtime.checkReadiness()).rejects.toThrow(/closed/u);
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues after hostile failure logging and recovers readiness', async () => {
    const selected = dependencies();
    const failure = new Error('postgres unavailable');
    vi.mocked(selected.scanner.scanDue)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({
        claimed: 0,
        accepted: 0,
        skipped: 0,
        paused: 0,
        deferred: 0,
        maxLagSeconds: 0,
      });
    selected.logger.error.mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    const runtime = await testTriggerRuntime(
      { ...options, pollIntervalMillis: 10 },
      {
        ...selected,
        checkpointFactory: () => ({ checkpoint: {} }),
      },
    );

    await expect(runtime.checkReadiness()).rejects.toThrow(/latest scan/u);
    await vi.waitFor(() => {
      expect(
        vi.mocked(selected.scanner.scanDue).mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
    });
    await expect(runtime.checkReadiness()).resolves.toBeUndefined();
    expect(selected.logger.error).toHaveBeenCalledWith(
      'trigger.scan_failed',
      { safeErrorCode: 'trigger.scan_failed' },
      expect.objectContaining({ errors: [failure] }),
    );
    await runtime.close();
  });

  it('bounds shutdown and defers adapters until an ignored scan settles', async () => {
    const selected = dependencies();
    const scan =
      Promise.withResolvers<
        Awaited<ReturnType<ScheduleTriggerScanner['scanDue']>>
      >();
    vi.mocked(selected.scanner.scanDue).mockReturnValue(scan.promise);
    const runtime = await testTriggerRuntime(
      { ...options, backgroundTaskShutdownTimeoutMillis: 5 },
      {
        ...selected,
        checkpointFactory: () => ({ checkpoint: {} }),
      },
    );
    await vi.waitFor(() => {
      expect(selected.scanner.scanDue).toHaveBeenCalledOnce();
    });
    const first = runtime.close();
    expect(runtime.close()).toBe(first);
    await expect(first).rejects.toMatchObject({
      name: 'BackgroundTaskShutdownTimeoutError',
    });
    expect(selected.scanner.close).not.toHaveBeenCalled();
    expect(selected.reconciliation.close).not.toHaveBeenCalled();

    scan.resolve({
      claimed: 0,
      accepted: 0,
      skipped: 0,
      paused: 0,
      deferred: 0,
      maxLagSeconds: 0,
    });
    await vi.waitFor(() => {
      expect(selected.scanner.close).toHaveBeenCalledOnce();
      expect(selected.reconciliation.close).toHaveBeenCalledOnce();
    });
  });

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
});
