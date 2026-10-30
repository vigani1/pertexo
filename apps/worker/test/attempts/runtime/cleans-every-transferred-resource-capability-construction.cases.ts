import { expect, it, vi } from 'vitest';

import { database } from './fixture.js';
import { testNodeAttemptRuntime } from '../../support/runtime-factories.js';

export function registerCleansEveryTransferredResourceCapabilityConstruction(): void {
  it('cleans every transferred resource when capability construction fails and preserves cleanup errors', async () => {
    const primary = new Error('capability construction failed');
    const cleanup = new Error('reader close failed');
    const closePreview = vi.fn().mockResolvedValue(undefined);
    const closeInvoker = vi.fn().mockResolvedValue(undefined);
    const closeRunStore = vi.fn().mockResolvedValue(undefined);
    const closeReader = vi.fn().mockRejectedValue(cleanup);
    const closeNotifications = vi.fn().mockResolvedValue(undefined);

    const result = await testNodeAttemptRuntime(
      {
        artifactStore: {} as never,
        connectionEncryption: {} as never,
        database,
        heartbeatIntervalMillis: 10,
        leaseDurationSeconds: 30,
        preview: {
          invoker: { close: closeInvoker, invoke: vi.fn() },
          runStore: {
            claim: vi.fn(),
            close: closePreview,
            complete: vi.fn(),
            heartbeat: vi.fn(),
            markDispatched: vi.fn(),
          },
        },
        redisUrl: 'redis://localhost:6379/0',
        workerId: 'worker-1',
      },
      {
        capabilityFactory: vi.fn().mockRejectedValue(primary),
        engine: { prepare: vi.fn() },
        notifications: {
          close: closeNotifications,
          publish: vi.fn(),
          resync: vi.fn(),
        },
        reader: {
          close: closeReader,
          readForExecution: vi.fn(),
        },
        registry: { execute: vi.fn() },
        runStore: {
          claimDelivery: vi.fn(),
          close: closeRunStore,
          complete: vi.fn(),
          heartbeat: vi.fn(),
          loadInputs: vi.fn(),
          readAttemptOutputs: vi.fn().mockResolvedValue([]),
          listNodeOutcomes: vi.fn().mockResolvedValue([]),
          readNodeOutputs: vi.fn().mockResolvedValue([]),
          readLoopDeclaration: vi.fn(),
          markDispatched: vi.fn(),
        },
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([primary, cleanup]);
    for (const close of [
      closePreview,
      closeInvoker,
      closeRunStore,
      closeReader,
      closeNotifications,
    ])
      expect(close).toHaveBeenCalledOnce();
  });

  it('drains the shared consumer first, aggregates close failures, and closes only once', async () => {
    const order: string[] = [];
    const consumerFailure = new Error('consumer close failed');
    const storeFailure = new Error('store close failed');
    let rejectConsumer: ((error: Error) => void) | undefined;
    const consumerDrain = new Promise<never>((_resolve, reject) => {
      rejectConsumer = reject;
    });
    const consumerClose = vi.fn(() => {
      order.push('consumer');
      return consumerDrain;
    });
    const storeClose = vi.fn(() => {
      order.push('store');
      throw storeFailure;
    });
    const runtime = await testNodeAttemptRuntime(
      {
        database,
        heartbeatIntervalMillis: 10,
        leaseDurationSeconds: 30,
        redisUrl: 'redis://localhost:6379/0',
        workerId: 'worker-1',
      },
      {
        consumerFactory: () => ({
          close: consumerClose,
          isReady: vi.fn().mockReturnValue(true),
          waitUntilReady: vi.fn().mockResolvedValue(undefined),
        }),
        engine: { prepare: vi.fn() },
        notifications: {
          close: vi.fn().mockResolvedValue(undefined),
          publish: vi.fn(),
          resync: vi.fn(),
        },
        reader: {
          close: vi.fn().mockResolvedValue(undefined),
          readForExecution: vi.fn(),
        },
        registry: { execute: vi.fn() },
        runStore: {
          claimDelivery: vi.fn(),
          close: storeClose,
          complete: vi.fn(),
          heartbeat: vi.fn(),
          loadInputs: vi.fn(),
          readAttemptOutputs: vi.fn().mockResolvedValue([]),
          listNodeOutcomes: vi.fn().mockResolvedValue([]),
          readNodeOutputs: vi.fn().mockResolvedValue([]),
          readLoopDeclaration: vi.fn(),
          markDispatched: vi.fn(),
        },
      },
    );

    const first = runtime.close();
    const second = runtime.close();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(order).toEqual(['consumer']);
    expect(storeClose).not.toHaveBeenCalled();
    rejectConsumer?.(consumerFailure);
    const result = await first.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(order[0]).toBe('consumer');
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([
      consumerFailure,
      storeFailure,
    ]);
    expect(consumerClose).toHaveBeenCalledOnce();
    expect(storeClose).toHaveBeenCalledOnce();
    await expect(runtime.checkReadiness()).rejects.toThrow(
      'Node-attempt runtime is closed',
    );
  });

  it('rechecks the terminal fence after an in-flight capability readiness probe', async () => {
    const readiness = Promise.withResolvers<undefined>();
    const capabilityClose = vi.fn().mockResolvedValue(undefined);
    const runtime = await testNodeAttemptRuntime(
      {
        artifactStore: {} as never,
        database,
        heartbeatIntervalMillis: 10,
        leaseDurationSeconds: 30,
        redisUrl: 'redis://localhost:6379/0',
        workerId: 'worker-1',
      },
      {
        capabilityFactory: vi.fn().mockResolvedValue({
          checkReadiness: vi.fn().mockReturnValue(readiness.promise),
          close: capabilityClose,
          factories: {},
        }),
        consumerFactory: () => ({
          close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
          isReady: vi.fn().mockReturnValue(true),
          waitUntilReady: vi.fn().mockResolvedValue(undefined),
        }),
        engine: { prepare: vi.fn() },
        notifications: {
          close: vi.fn().mockResolvedValue(undefined),
          publish: vi.fn(),
          resync: vi.fn(),
        },
        reader: {
          close: vi.fn().mockResolvedValue(undefined),
          readForExecution: vi.fn(),
        },
        registry: { execute: vi.fn() },
        runStore: {
          claimDelivery: vi.fn(),
          close: vi.fn().mockResolvedValue(undefined),
          complete: vi.fn(),
          heartbeat: vi.fn(),
          loadInputs: vi.fn(),
          readAttemptOutputs: vi.fn().mockResolvedValue([]),
          listNodeOutcomes: vi.fn().mockResolvedValue([]),
          readNodeOutputs: vi.fn().mockResolvedValue([]),
          readLoopDeclaration: vi.fn(),
          markDispatched: vi.fn(),
        },
      },
    );

    const pendingReadiness = runtime.checkReadiness();
    const closing = runtime.close();
    readiness.resolve(undefined);
    await expect(pendingReadiness).rejects.toThrow(
      'Node-attempt runtime is closed',
    );
    await closing;
    expect(capabilityClose).toHaveBeenCalledOnce();
  });
}
