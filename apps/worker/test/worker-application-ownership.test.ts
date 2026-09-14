import type { DatabaseRuntime } from '@pertexo/database/execution';
import { describe, expect, it, vi } from 'vitest';

import {
  createWorkerApplication,
  type WorkerApplicationCompositionFactories,
} from '../src/app.js';
import { parseWorkerConfig } from '../src/config/worker-config.js';
import { WORKSPACE_DATABASE } from '../src/platform/database/database.module.js';
import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';
import { WorkerShutdownCoordinator } from '../src/runtime/worker-shutdown-coordinator.js';

const config = parseWorkerConfig({
  DATABASE_DISPATCHER_URL:
    'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
  DATABASE_WORKER_URL:
    'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
  REDIS_URL: 'redis://localhost:6379/0',
});

const dependencies = {
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
  telemetry: {
    enabled: false,
    started: false,
    start: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
};

function runtime(close: () => Promise<void>): DatabaseRuntime {
  return { close };
}

describe('worker application construction ownership', () => {
  it('does not acquire a later owner when the first database runtime fails', async () => {
    const failure = new Error('worker database runtime failed');
    const applicationContext = vi.fn();
    const databaseRuntime = vi.fn(() => {
      throw failure;
    });
    const factories = {
      applicationContext,
      databaseRuntime,
    } as unknown as WorkerApplicationCompositionFactories;

    await expect(
      createWorkerApplication(config, dependencies, factories),
    ).rejects.toBe(failure);
    expect(databaseRuntime).toHaveBeenCalledOnce();
    expect(applicationContext).not.toHaveBeenCalled();
  });

  it('rolls back the worker runtime when dispatcher runtime construction fails', async () => {
    const failure = new Error('dispatcher database runtime failed');
    const workerClose = vi.fn().mockResolvedValue(undefined);
    const databaseRuntime = vi
      .fn()
      .mockReturnValueOnce(runtime(workerClose))
      .mockImplementationOnce(() => {
        throw failure;
      });
    const applicationContext = vi.fn();
    const factories = {
      applicationContext,
      databaseRuntime,
    } as unknown as WorkerApplicationCompositionFactories;

    await expect(
      createWorkerApplication(config, dependencies, factories),
    ).rejects.toBe(failure);
    expect(workerClose).toHaveBeenCalledOnce();
    expect(applicationContext).not.toHaveBeenCalled();
  });

  it('preserves context construction and every runtime rollback failure', async () => {
    const constructionFailure = new Error('Nest context failed');
    const workerFailure = new Error('worker runtime close failed');
    const dispatcherFailure = new Error('dispatcher runtime close failed');
    const workerClose = vi.fn(() => {
      throw workerFailure;
    });
    const dispatcherClose = vi.fn(() => Promise.reject(dispatcherFailure));
    const databaseRuntime = vi
      .fn()
      .mockReturnValueOnce(runtime(workerClose))
      .mockReturnValueOnce(runtime(dispatcherClose));
    const factories = {
      applicationContext: vi.fn().mockRejectedValue(constructionFailure),
      databaseRuntime,
    } as unknown as WorkerApplicationCompositionFactories;

    const failure = await createWorkerApplication(
      config,
      dependencies,
      factories,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      constructionFailure,
      workerFailure,
      dispatcherFailure,
    ]);
    expect(workerClose).toHaveBeenCalledOnce();
    expect(dispatcherClose).toHaveBeenCalledOnce();
  });

  it('preserves a compatibility failure when Nest close itself fails', async () => {
    const compatibilityFailure = new Error('database compatibility failed');
    const nestCloseFailure = new Error('Nest before-shutdown hook failed');
    const shutdown = new WorkerShutdownCoordinator(new WorkerDrainState());
    const application = {
      close: vi.fn(() => {
        throw nestCloseFailure;
      }),
      get: vi.fn((token: unknown) => {
        if (token === WorkerShutdownCoordinator) return shutdown;
        if (token === WORKSPACE_DATABASE)
          return {
            checkCompatibility: () => Promise.reject(compatibilityFailure),
          };
        throw new Error('Unexpected application token');
      }),
    };
    const factories = {
      applicationContext: vi.fn().mockResolvedValue(application),
      databaseRuntime: vi
        .fn()
        .mockReturnValue(runtime(vi.fn().mockResolvedValue(undefined))),
    } as unknown as WorkerApplicationCompositionFactories;

    const failure = await createWorkerApplication(
      config,
      dependencies,
      factories,
    ).catch((error: unknown) => error);

    expect((failure as AggregateError).errors).toEqual([
      compatibilityFailure,
      nestCloseFailure,
    ]);
    expect(application.close).toHaveBeenCalledOnce();
  });
});

describe('worker shutdown coordinator', () => {
  it('drains first, settles all owners in order, caches close, and reports every failure', async () => {
    const drain = new WorkerDrainState();
    const coordinator = new WorkerShutdownCoordinator(drain);
    const order: string[] = [];
    const firstFailure = new Error('transport close failed');
    const secondFailure = new Error('database close failed');
    const barrier = Promise.withResolvers<undefined>();
    coordinator.register('transport', () => {
      expect(drain.canAcceptWork()).toBe(false);
      order.push('transport');
      throw firstFailure;
    });
    coordinator.register('database', async () => {
      order.push('database:start');
      await barrier.promise;
      order.push('database:end');
      throw secondFailure;
    });
    coordinator.register('telemetry', () => {
      order.push('telemetry');
    });

    const first = coordinator.close();
    const second = coordinator.close();
    expect(second).toBe(first);
    await vi.waitFor(() => {
      expect(order).toEqual(['transport', 'database:start']);
    });
    expect(() => {
      coordinator.register('late', vi.fn());
    }).toThrow('closed');

    barrier.resolve(undefined);
    await expect(first).resolves.toBeUndefined();
    expect(order).toEqual([
      'transport',
      'database:start',
      'database:end',
      'telemetry',
    ]);
    const failure = (() => {
      try {
        coordinator.throwIfFailed();
      } catch (error: unknown) {
        return error;
      }
      return undefined;
    })();
    expect((failure as AggregateError).errors).toEqual([
      firstFailure,
      secondFailure,
    ]);
  });
});
