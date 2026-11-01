import { parseDatabaseConfig } from '@pertexo/database/testing';
import {
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
  type FailureNotificationStore,
} from '@pertexo/core/testing';

import { expect, it, vi } from 'vitest';
import {
  createPreviewReconciliationHandler,
  mapPreviewReconciliationError,
} from '../../../src/previews/reconciliation.js';
import { delivery, maintenanceRuntime, idleStores } from './fixture.js';
import { testMaintenanceRuntime } from '../../support/runtime-factories.js';

export function registerContainsThrowingSTelemetryCallbackWithout(): void {
  it.each(['reconciliation', 'terminal'] as const)(
    'contains a throwing %s telemetry callback without changing a committed result',
    async (failingCallback) => {
      const result = {
        kind: 'completed' as const,
        mayContactProvider: false,
        mayCauseExternalSideEffect: false,
        possiblyDispatched: false,
        sideEffectClass: 'safe' as const,
        status: 'succeeded' as const,
        usesConnection: false,
      };
      const selected = delivery();
      const recordReconciliation = vi.fn(() => {
        if (failingCallback === 'reconciliation')
          throw new Error('reconciliation metric failed');
      });
      const recordTerminal = vi.fn(() => {
        if (failingCallback === 'terminal')
          throw new Error('terminal metric failed');
      });
      const handler = createPreviewReconciliationHandler(
        { reconcile: vi.fn().mockResolvedValue(result) },
        { recordReconciliation, recordTerminal },
      );

      await expect(
        handler.handle(selected, { signal: new AbortController().signal }),
      ).resolves.toBe(result);
      expect(recordReconciliation).toHaveBeenCalledOnce();
      if (failingCallback === 'terminal')
        expect(recordTerminal).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [new PreviewDeliveryMismatchError(), /durable state verification/u],
    [new PreviewAttemptStateError('already_terminal'), /already_terminal/u],
  ] as const)('maps permanent reconciliation error %#', (error, message) => {
    const mapped = mapPreviewReconciliationError(error);
    expect(mapped).toBeInstanceOf(Error);
    if (!(mapped instanceof Error))
      throw new TypeError('expected mapped error');
    expect(mapped.name).toBe('UnrecoverableError');
    expect(mapped.message).toMatch(message);
  });

  it('preserves a transient reconciliation failure', () => {
    const transient = new Error('postgres unavailable');
    expect(mapPreviewReconciliationError(transient)).toBe(transient);
  });

  it('closes the durable store when consumer construction fails', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const store = { close, reconcile: vi.fn() };

    await expect(
      testMaintenanceRuntime(
        {
          database: parseDatabaseConfig({
            connectionString:
              'postgresql://pertexo_app:secret@localhost:5432/pertexo',
          }),
          redisUrl: 'redis://localhost:6379/0',
        },
        {
          consumerFactory: () => {
            throw new Error('consumer construction failed');
          },
          reconciliationStore: store,
        },
      ),
    ).rejects.toThrow('consumer construction failed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the maintenance consumer and store exactly once', async () => {
    const consumerClose = vi
      .fn()
      .mockResolvedValue({ abortedJobs: 0, forced: false });
    const storeClose = vi.fn().mockResolvedValue(undefined);
    const runtime = await testMaintenanceRuntime(
      {
        database: parseDatabaseConfig({
          connectionString:
            'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        }),
        redisUrl: 'redis://localhost:6379/0',
      },
      {
        consumerFactory: vi.fn().mockReturnValue({
          close: consumerClose,
          isReady: vi.fn().mockReturnValue(true),
          waitUntilReady: vi.fn().mockResolvedValue(undefined),
        }),
        reconciliationStore: { close: storeClose, reconcile: vi.fn() },
      },
    );

    await Promise.all([runtime.close(), runtime.close()]);
    expect(consumerClose).toHaveBeenCalledOnce();
    expect(storeClose).toHaveBeenCalledOnce();
  });

  it('aborts in-flight notification recovery and prevents another recovery pass', async () => {
    let observedSignal: AbortSignal | undefined;
    const recovery = vi.fn(
      (_limit: number, _maxAttempts: number, signal?: AbortSignal) => {
        observedSignal = signal;
        return new Promise<number>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('recovery aborted'));
            },
            { once: true },
          );
        });
      },
    );
    const notificationClose = vi.fn().mockResolvedValue(undefined);
    const notificationStore = {
      claimDelivery:
        vi.fn<NonNullable<FailureNotificationStore['claimDelivery']>>(),
      close: notificationClose,
      completeDelivery:
        vi.fn<NonNullable<FailureNotificationStore['completeDelivery']>>(),
      fenceDispatch:
        vi.fn<NonNullable<FailureNotificationStore['fenceDispatch']>>(),
      loadDestination:
        vi.fn<NonNullable<FailureNotificationStore['loadDestination']>>(),
      recoverDue: recovery,
    } satisfies FailureNotificationStore;
    const runtime = await maintenanceRuntime(notificationStore, 100);

    await vi.waitFor(() => {
      expect(recovery).toHaveBeenCalledOnce();
    });
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
    expect(recovery).toHaveBeenCalledOnce();
    expect(notificationClose).toHaveBeenCalledOnce();
  });

  it('waits for initial recovery health and never becomes ready after close', async () => {
    const recovery = Promise.withResolvers<number>();
    const notificationStore = {
      claimDelivery:
        vi.fn<NonNullable<FailureNotificationStore['claimDelivery']>>(),
      close: vi
        .fn<NonNullable<FailureNotificationStore['close']>>()
        .mockResolvedValue(undefined),
      completeDelivery:
        vi.fn<NonNullable<FailureNotificationStore['completeDelivery']>>(),
      fenceDispatch:
        vi.fn<NonNullable<FailureNotificationStore['fenceDispatch']>>(),
      loadDestination:
        vi.fn<NonNullable<FailureNotificationStore['loadDestination']>>(),
      recoverDue: vi.fn<NonNullable<FailureNotificationStore['recoverDue']>>(
        () => recovery.promise,
      ),
    } satisfies FailureNotificationStore;
    const runtime = await maintenanceRuntime(notificationStore, 100);
    let readinessSettled = false;
    const readiness = runtime.checkReadiness().finally(() => {
      readinessSettled = true;
    });
    await Promise.resolve();
    expect(readinessSettled).toBe(false);

    recovery.resolve(0);
    await expect(readiness).resolves.toBeUndefined();
    await runtime.close();
    await expect(runtime.checkReadiness()).rejects.toThrow(/closed/u);
  });

  it('exposes a failed first recovery scan through readiness', async () => {
    const notificationStore = {
      claimDelivery:
        vi.fn<NonNullable<FailureNotificationStore['claimDelivery']>>(),
      close: vi
        .fn<NonNullable<FailureNotificationStore['close']>>()
        .mockResolvedValue(undefined),
      completeDelivery:
        vi.fn<NonNullable<FailureNotificationStore['completeDelivery']>>(),
      fenceDispatch:
        vi.fn<NonNullable<FailureNotificationStore['fenceDispatch']>>(),
      loadDestination:
        vi.fn<NonNullable<FailureNotificationStore['loadDestination']>>(),
      recoverDue: vi
        .fn<NonNullable<FailureNotificationStore['recoverDue']>>()
        .mockRejectedValue(new Error('postgres unavailable')),
    } satisfies FailureNotificationStore;
    const runtime = await maintenanceRuntime(notificationStore, 100);

    await expect(runtime.checkReadiness()).rejects.toThrow(/latest scan/u);
    await runtime.close();
  });

  it('is ready without failure-notification delivery', async () => {
    vi.useFakeTimers();
    try {
      const runtime = await testMaintenanceRuntime(
        {
          database: parseDatabaseConfig({
            connectionString:
              'postgresql://pertexo_app:secret@localhost:5432/pertexo',
          }),
          redisUrl: 'redis://localhost:6379/0',
        },
        {
          ...idleStores(),
          consumerFactory: vi.fn().mockReturnValue({
            close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
            isReady: vi.fn().mockReturnValue(true),
            waitUntilReady: vi.fn().mockResolvedValue(undefined),
          }),
        },
      );

      await expect(runtime.checkReadiness()).resolves.toBeUndefined();
      await runtime.close();
    } finally {
      vi.useRealTimers();
    }
  });
}
