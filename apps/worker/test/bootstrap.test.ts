import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '@pertexo/database/testing';
import { WorkerReadiness } from '../src/runtime/health/readiness.js';
import {
  createWorkerApplication,
  database,
  workerConfig,
  logger,
  dependencies,
} from './bootstrap/fixture.js';
import type { TelemetryLifecycle } from '@pertexo/observability/server';
import { WorkerDrainState } from '../src/runtime/shutdown/drain-state.js';

describe('worker application bootstrap', () => {
  it('creates a standalone context without an HTTP server', async () => {
    const checkReadiness = vi.fn(() => database.checkReadiness());
    const selectedDatabase: WorkspaceDatabase = {
      ...database,
      checkReadiness,
    };
    const selected = dependencies(selectedDatabase);
    const app = await createWorkerApplication(workerConfig, selected);

    try {
      expect('getHttpServer' in app).toBe(false);
      expect(selected.workerProcessStart).toHaveBeenCalledOnce();
      expect(checkReadiness).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('counts each newly composed worker process instance', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const selected = dependencies(database, {
      enabled: true,
      flush,
      shutdown: vi.fn().mockResolvedValue(undefined),
      start: vi.fn(),
      started: true,
    });
    const first = await createWorkerApplication(workerConfig, selected);
    await first.close();
    const restarted = await createWorkerApplication(workerConfig, selected);

    try {
      expect(selected.workerProcessStart).toHaveBeenCalledTimes(2);
      expect(flush).toHaveBeenCalledTimes(2);
    } finally {
      await restarted.close();
    }
  });

  it('keeps startup successful when the process start metric fails', async () => {
    const selected = dependencies();
    const metricFailure = new Error('process metric unavailable');
    selected.workerProcessStart.mockImplementation(() => {
      throw metricFailure;
    });
    const warn = vi.fn();

    const app = await createWorkerApplication(workerConfig, {
      ...selected,
      logger: { ...logger, warn },
    });
    try {
      expect(selected.workerProcessStart).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        'worker.process_start_metric_failed',
        {},
        metricFailure,
      );
    } finally {
      await app.close();
    }
  });

  it('checks every composed runtime for readiness and closes each on shutdown', async () => {
    const selected = dependencies();
    const app = await createWorkerApplication(workerConfig, selected);
    const runtimes = [
      selected.coordinatorRuntime,
      selected.nodeAttemptRuntime,
      selected.maintenanceRuntime,
      selected.triggerRuntime,
    ];

    await expect(
      app.get(WorkerReadiness).checkReadiness(),
    ).resolves.toBeUndefined();
    for (const runtime of runtimes)
      expect(runtime.checkReadiness).toHaveBeenCalled();
    await app.close();
    for (const runtime of runtimes)
      expect(runtime.close).toHaveBeenCalledOnce();
    // Vitest inspects this mock identity; it never calls the unbound method.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(selected.workflowAutoPauseRuntime.close).toHaveBeenCalledOnce();
    // Vitest inspects this mock identity; it never calls the unbound method.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(selected.retentionRuntime.close).toHaveBeenCalledOnce();
  });

  it('fails startup and closes resources when database readiness fails', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const unavailableDatabase: WorkspaceDatabase = {
      ...database,
      checkReadiness: vi
        .fn()
        .mockRejectedValue(new Error('migration mismatch')),
      close,
    };

    await expect(
      createWorkerApplication(workerConfig, dependencies(unavailableDatabase)),
    ).rejects.toThrow('migration mismatch');
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes every constructed transport resource when dispatcher readiness fails', async () => {
    const selected = dependencies();
    selected.dispatcherReadiness.mockRejectedValue(
      new Error('dispatcher policy mismatch'),
    );

    await expect(
      createWorkerApplication(workerConfig, selected),
    ).rejects.toThrow('dispatcher policy mismatch');

    expect(selected.dispatcherClose).toHaveBeenCalledOnce();
    expect(selected.queueClose).toHaveBeenCalledOnce();
  });

  it('attempts database and telemetry shutdown after transport cleanup fails', async () => {
    const order: string[] = [];
    const databaseClose = vi.fn(() => {
      order.push('database');
      return Promise.resolve();
    });
    const telemetryShutdown = vi.fn(() => {
      order.push('telemetry');
      return Promise.resolve();
    });
    const selected = dependencies(
      { ...database, close: databaseClose },
      {
        enabled: true,
        started: true,
        start: vi.fn(),
        shutdown: telemetryShutdown,
      },
    );
    const transportFailure = new Error('dispatcher database close failed');
    selected.dispatcherClose.mockImplementation(() => {
      order.push('transport');
      return Promise.reject(transportFailure);
    });
    const app = await createWorkerApplication(workerConfig, selected);

    const failure = await app.close().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(selected.dispatcherClose).toHaveBeenCalledOnce();
    expect(selected.queueClose).toHaveBeenCalledOnce();
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(telemetryShutdown).toHaveBeenCalledOnce();
    expect(order).toEqual(['transport', 'database', 'telemetry']);
  });

  it('shares one application close settlement and closes each owner once', async () => {
    const databaseClose = vi.fn().mockResolvedValue(undefined);
    const selected = dependencies({ ...database, close: databaseClose });
    const app = await createWorkerApplication(workerConfig, selected);

    const first = app.close();
    const second = app.close();
    expect(second).toBe(first);
    await first;

    expect(selected.dispatcherClose).toHaveBeenCalledOnce();
    expect(selected.queueClose).toHaveBeenCalledOnce();
    expect(databaseClose).toHaveBeenCalledOnce();
    // Vitest inspects this mock identity; it never calls the unbound method.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(selected.telemetry.shutdown).toHaveBeenCalledOnce();
  });

  it('connects drain state to readiness and admission', async () => {
    const app = await createWorkerApplication(workerConfig, dependencies());
    const drainState = app.get(WorkerDrainState);
    const readiness = app.get(WorkerReadiness);

    expect(drainState.canAcceptWork()).toBe(true);
    drainState.beginDrain();
    expect(() => {
      readiness.assertCanAcceptWork();
    }).toThrow('worker is draining');
    await expect(readiness.checkReadiness()).rejects.toThrow(
      'worker is draining',
    );

    await app.close();
  });

  it('enters drain state before shutdown resources close', async () => {
    const lifecycle: { drainState?: WorkerDrainState } = {};
    const close = vi.fn().mockImplementation(() => {
      expect(lifecycle.drainState?.canAcceptWork()).toBe(false);
      return Promise.resolve();
    });
    const selectedDatabase: WorkspaceDatabase = { ...database, close };
    const app = await createWorkerApplication(
      workerConfig,
      dependencies(selectedDatabase),
    );
    lifecycle.drainState = app.get(WorkerDrainState);

    expect(app.get(WorkerDrainState).canAcceptWork()).toBe(true);
    await app.close();

    expect(close).toHaveBeenCalledOnce();
  });

  it('shuts telemetry down with the worker application lifecycle', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const telemetry = {
      enabled: true,
      started: true,
      start: vi.fn<NonNullable<TelemetryLifecycle['start']>>(),
      shutdown,
    } satisfies TelemetryLifecycle;
    const app = await createWorkerApplication(
      workerConfig,
      dependencies(database, telemetry),
    );

    await app.close();

    expect(shutdown).toHaveBeenCalledOnce();
  });
});
