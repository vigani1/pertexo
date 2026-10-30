import type {
  WorkspaceDatabase,
  WorkspaceTransaction,
  WorkspaceTransactionOptions,
} from '@pertexo/database/testing';

import { expect, it, vi } from 'vitest';

import { NestWorkspaceDatabase } from '../../src/platform/database/module.js';

import { WorkerReadiness } from '../../src/runtime/health/readiness.js';
import {
  createWorkerApplication,
  database,
  workerConfig,
  logger,
  dependencies,
} from './fixture.js';

export function registerForwardsWorkspaceTransactionIdentityOptionsWithout(): void {
  it('forwards workspace transaction identity and options without adding a transaction', async () => {
    const signal = new AbortController().signal;
    const options = { signal, statementTimeoutMillis: 1_234 } as const;
    const operation = vi.fn(() => Promise.resolve('workspace-result'));
    const forwarded = vi.fn();
    const withWorkspace: WorkspaceDatabase['withWorkspace'] = async <T>(
      selectedWorkspaceId: string,
      selectedOperation: (transaction: WorkspaceTransaction) => Promise<T>,
      selectedOptions?: WorkspaceTransactionOptions,
    ): Promise<T> => {
      forwarded(selectedWorkspaceId, selectedOperation, selectedOptions);
      expect(selectedWorkspaceId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      expect(selectedOperation).toBe(operation);
      expect(selectedOptions).toBe(options);
      return selectedOperation(undefined as unknown as WorkspaceTransaction);
    };
    const wrapped = new NestWorkspaceDatabase({ ...database, withWorkspace });

    await expect(
      wrapped.withWorkspace(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        operation,
        options,
      ),
    ).resolves.toBe('workspace-result');
    expect(forwarded).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledOnce();
  });

  it('preserves rejection and already-aborted signal semantics through the workspace adapter', async () => {
    const failure = new Error('workspace transaction rejected');
    const controller = new AbortController();
    controller.abort(failure);
    const forwarded = vi.fn();
    const withWorkspace: WorkspaceDatabase['withWorkspace'] = <T>(
      _workspaceId: string,
      _operation: (transaction: WorkspaceTransaction) => Promise<T>,
      options?: WorkspaceTransactionOptions,
    ): Promise<T> => {
      forwarded(options);
      expect(options?.signal).toBe(controller.signal);
      return Promise.reject(failure);
    };
    const wrapped = new NestWorkspaceDatabase({ ...database, withWorkspace });

    await expect(
      wrapped.withWorkspace('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', vi.fn(), {
        signal: controller.signal,
      }),
    ).rejects.toBe(failure);
    expect(forwarded).toHaveBeenCalledWith({ signal: controller.signal });
  });

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
}
