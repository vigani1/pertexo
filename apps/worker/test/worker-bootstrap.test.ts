import type {
  OutboxDispatcherDatabase,
  WorkspaceDatabase,
  WorkspaceTransaction,
  WorkspaceTransactionOptions,
} from '@pertexo/database/testing';
import {
  JOB_NAME,
  type QueueConsumer,
  type QueueProducer,
} from '@pertexo/queue';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import type { TransportMetrics } from '@pertexo/observability/transport-metrics';
import { describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/unbound-method -- assertions target injected seam fakes */

import { createWorkerApplication } from '../src/app.js';
import type { CoordinatorRuntime } from '../src/execution/coordinator-runtime.js';
import type { NodeAttemptRuntime } from '../src/execution/node-attempt-runtime.js';
import type { PreviewMaintenanceRuntime } from '../src/execution/preview-maintenance-runtime.js';
import type { TriggerRuntime } from '../src/triggers/trigger-runtime.js';
import { NestWorkspaceDatabase } from '../src/platform/database/database.module.js';
import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';
import { WorkerReadiness } from '../src/runtime/worker-readiness.js';

const database: WorkspaceDatabase = {
  withWorkspace: async <T>(
    _workspaceId: string,
    operation: (transaction: never) => Promise<T>,
  ): Promise<T> => operation(undefined as never),
  checkCompatibility: () =>
    Promise.resolve({
      migrationHead: '0000_rls_probe.sql',
      postgresMajor: 18,
      role: 'pertexo_worker',
    }),
  checkReadiness: () =>
    Promise.resolve({
      migrationHead: '0000_rls_probe.sql',
      postgresMajor: 18,
      role: 'pertexo_worker',
    }),
  close: () => Promise.resolve(),
};

const workerConfig = {
  coordinator: {
    dueWakeupBatchSize: 25,
    dueWakeupPollIntervalMillis: 250,
    maximumAdmissions: 32,
    runTimeoutFailureContextEnabled: false,
  },
  nodeAttempt: {
    heartbeatIntervalMillis: 10_000,
    leaseDurationSeconds: 30,
    workerId: 'worker-test',
  },
  database: {
    connectionString:
      'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 5,
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  },
  dispatcherDatabase: {
    connectionString:
      'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 2,
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  },
  nodeEnv: 'test' as const,
  nodeCompatibilityCohort: 'core' as const,
  logLevel: 'debug' as const,
  observability: {
    environment: 'test' as const,
    logLevel: 'silent' as const,
    otlpHeaders: {},
    serviceName: 'pertexo-worker',
    serviceVersion: 'test',
  },
  resourceSafety: {
    maximumEventLoopDelayMillis: 200,
    maximumRssBytes: 805_306_368,
    sampleIntervalMillis: 5_000,
    unhealthySamplesBeforeDrain: 3,
  },
  outboxDispatcher: {
    batchSize: 10,
    enabledJobNames: [],
    leaseDurationMillis: 30_000,
    leaseOwner: 'outbox:test-worker',
    maxAttempts: 3,
    operationTimeoutMillis: 5_000,
    pollIntervalMillis: 250,
    retryDelayMillis: 1_000,
  },
  triggerRuntime: {
    batchSize: 25,
    leaseDurationSeconds: 30,
    leaseOwner: 'schedule:worker-test',
    onTimeWindowSeconds: 300,
    pollIntervalMillis: 250,
  },
  redisUrl: 'redis://localhost:6379/0',
};

const logger: StructuredLogger = {
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
};

function transportMetrics(): {
  metrics: TransportMetrics;
  recordWorkerProcessStart: ReturnType<typeof vi.fn>;
} {
  const recordWorkerProcessStart = vi.fn();
  const metrics = {
    addActiveConcurrency: vi.fn(),
    observeArtifacts: vi.fn(),
    observeExecutionStorage: vi.fn(),
    observeOutbox: vi.fn(),
    observeQueue: vi.fn(),
    recordConsumerLifecycle: vi.fn(),
    recordHandlerFinished: vi.fn(),
    recordOutboxClaim: vi.fn(),
    recordOutboxDispatchLatency: vi.fn(),
    recordOutboxLeaseEvent: vi.fn(),
    recordOutboxPublish: vi.fn(),
    recordQueueStall: vi.fn(),
    recordWorkerProcessStart,
  } satisfies TransportMetrics;
  return { metrics, recordWorkerProcessStart };
}

function dependencies(
  selectedDatabase: WorkspaceDatabase = database,
  telemetry: TelemetryLifecycle = {
    enabled: false,
    started: false,
    start: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
) {
  const dispatcherReadiness = vi.fn().mockResolvedValue(undefined);
  const dispatcherClose = vi.fn().mockResolvedValue(undefined);
  const queueClose = vi.fn().mockResolvedValue(undefined);
  const dispatcherDatabase: OutboxDispatcherDatabase = {
    checkReadiness: dispatcherReadiness,
    claimBatch: vi.fn().mockResolvedValue({ events: [], exhaustedCount: 0 }),
    close: dispatcherClose,
    markPublished: vi.fn().mockResolvedValue(true),
    observeBacklog: vi.fn().mockResolvedValue({ backlog: 0 }),
    releaseOrFail: vi.fn().mockResolvedValue('retry_scheduled'),
  };
  const queueProducer: QueueProducer = {
    close: queueClose,
    isReady: vi.fn().mockReturnValue(true),
    observe: vi.fn().mockResolvedValue([]),
    publish: vi.fn(),
    waitUntilReady: vi.fn().mockResolvedValue(undefined),
  };
  const metrics = transportMetrics();
  return {
    database: selectedDatabase,
    dispatcherClose,
    dispatcherDatabase,
    dispatcherReadiness,
    logger,
    queueProducer,
    queueClose,
    readinessMarker: { setReady: vi.fn().mockResolvedValue(undefined) },
    telemetry,
    transportMetrics: metrics.metrics,
    workerProcessStart: metrics.recordWorkerProcessStart,
  };
}

describe('worker application bootstrap', () => {
  it('fails readiness when the connection is not the configured worker role', async () => {
    const wrongRoleDatabase: WorkspaceDatabase = {
      ...database,
      checkReadiness: () =>
        Promise.resolve({
          migrationHead: '0013_published_workflow_execution.sql',
          postgresMajor: 18,
          role: 'pertexo_api',
        }),
    };
    const wrapped = new NestWorkspaceDatabase(
      wrongRoleDatabase,
      'pertexo_worker',
    );

    await expect(wrapped.checkReadiness()).rejects.toThrow(
      'Worker database role is incompatible',
    );
    await expect(wrapped.checkCompatibility()).resolves.toMatchObject({
      role: 'pertexo_worker',
    });
  });

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
    const wrapped = new NestWorkspaceDatabase(
      { ...database, withWorkspace },
      'pertexo_worker',
    );

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
    const wrapped = new NestWorkspaceDatabase(
      { ...database, withWorkspace },
      'pertexo_worker',
    );

    await expect(
      wrapped.withWorkspace('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', vi.fn(), {
        signal: controller.signal,
      }),
    ).rejects.toBe(failure);
    expect(forwarded).toHaveBeenCalledWith({ signal: controller.signal });
  });

  it('creates a standalone context without an HTTP server', async () => {
    const checkCompatibility = vi.fn(() => database.checkCompatibility());
    const checkReadiness = vi.fn(() => database.checkReadiness());
    const selectedDatabase: WorkspaceDatabase = {
      ...database,
      checkCompatibility,
      checkReadiness,
    };
    const selected = dependencies(selectedDatabase);
    const app = await createWorkerApplication(workerConfig, selected);

    try {
      expect('getHttpServer' in app).toBe(false);
      expect(selected.workerProcessStart).toHaveBeenCalledOnce();
      expect(checkCompatibility).toHaveBeenCalledOnce();
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

  it('keeps startup successful when process metrics and warning diagnostics both fail', async () => {
    const selected = dependencies();
    const metricFailure = new Error('process metric unavailable');
    selected.workerProcessStart.mockImplementation(() => {
      throw metricFailure;
    });
    const warn = vi.fn(() => {
      throw new Error('warning sink unavailable');
    });

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

  it('gates coordinator dispatch on the composed consumer and closes it on shutdown', async () => {
    const selected = dependencies();
    const consumer: QueueConsumer = {
      close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
      isReady: vi.fn().mockReturnValue(true),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
    };
    const coordinatorRuntime: CoordinatorRuntime = {
      consumer,
      checkReadiness: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const enabledConfig = {
      ...workerConfig,
      outboxDispatcher: {
        ...workerConfig.outboxDispatcher,
        enabledJobNames: [JOB_NAME.advanceWorkflowRun],
      },
    };
    const app = await createWorkerApplication(enabledConfig, {
      ...selected,
      coordinatorRuntime,
    });

    expect(consumer.waitUntilReady).toHaveBeenCalledOnce();
    try {
      expect(consumer.isReady).toHaveBeenCalled();
    } finally {
      await app.close();
    }
    expect(coordinatorRuntime.close).toHaveBeenCalledOnce();
  });

  it('gates node-attempt dispatch on the composed consumer and closes it on shutdown', async () => {
    const selected = dependencies();
    const consumer: QueueConsumer = {
      close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
      isReady: vi.fn().mockReturnValue(true),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
    };
    const nodeAttemptRuntime: NodeAttemptRuntime = {
      consumer,
      close: vi.fn().mockResolvedValue(undefined),
    };
    const enabledConfig = {
      ...workerConfig,
      outboxDispatcher: {
        ...workerConfig.outboxDispatcher,
        enabledJobNames: [JOB_NAME.executeNodeAttempt],
      },
    };
    const app = await createWorkerApplication(enabledConfig, {
      ...selected,
      nodeAttemptRuntime,
    });

    expect(consumer.waitUntilReady).toHaveBeenCalledOnce();
    try {
      expect(consumer.isReady).toHaveBeenCalled();
    } finally {
      await app.close();
    }
    expect(nodeAttemptRuntime.close).toHaveBeenCalledOnce();
  });

  it('gates preview dispatch on the shared attempts consumer', async () => {
    const selected = dependencies();
    const consumer: QueueConsumer = {
      close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
      isReady: vi.fn().mockReturnValue(true),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
    };
    const nodeAttemptRuntime: NodeAttemptRuntime = {
      consumer,
      close: vi.fn().mockResolvedValue(undefined),
    };
    const enabledConfig = {
      ...workerConfig,
      outboxDispatcher: {
        ...workerConfig.outboxDispatcher,
        enabledJobNames: [JOB_NAME.executePreviewAttempt],
      },
    };
    const app = await createWorkerApplication(enabledConfig, {
      ...selected,
      nodeAttemptRuntime,
    });

    expect(consumer.waitUntilReady).toHaveBeenCalledOnce();
    try {
      expect(consumer.isReady).toHaveBeenCalled();
    } finally {
      await app.close();
    }
    expect(nodeAttemptRuntime.close).toHaveBeenCalledOnce();
  });

  it('gates preview reconciliation dispatch on its maintenance consumer', async () => {
    const selected = dependencies();
    const consumer: QueueConsumer = {
      close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
      isReady: vi.fn().mockReturnValue(true),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
    };
    const previewMaintenanceRuntime: PreviewMaintenanceRuntime = {
      consumer,
      checkReadiness: vi.fn().mockResolvedValue(undefined),
      whenIdle: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const enabledConfig = {
      ...workerConfig,
      outboxDispatcher: {
        ...workerConfig.outboxDispatcher,
        enabledJobNames: [JOB_NAME.reconcilePreviewAttempt],
      },
    };
    const app = await createWorkerApplication(enabledConfig, {
      ...selected,
      previewMaintenanceRuntime,
    });

    expect(consumer.waitUntilReady).toHaveBeenCalledOnce();
    try {
      expect(consumer.isReady).toHaveBeenCalled();
    } finally {
      await app.close();
    }
    expect(previewMaintenanceRuntime.close).toHaveBeenCalledOnce();
  });

  it('gates trigger reconciliation dispatch on the trigger runtime consumer', async () => {
    const selected = dependencies();
    const consumer: QueueConsumer = {
      close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
      isReady: vi.fn().mockReturnValue(true),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
    };
    const triggerRuntime: TriggerRuntime = {
      consumer,
      checkReadiness: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const enabledConfig = {
      ...workerConfig,
      outboxDispatcher: {
        ...workerConfig.outboxDispatcher,
        enabledJobNames: [JOB_NAME.reconcileWorkflowTriggers],
      },
    };
    const app = await createWorkerApplication(enabledConfig, {
      ...selected,
      triggerRuntime,
    });

    expect(consumer.waitUntilReady).toHaveBeenCalledOnce();
    await expect(
      app.get(WorkerReadiness).checkReadiness(),
    ).resolves.toBeUndefined();
    expect(triggerRuntime.checkReadiness).toHaveBeenCalled();
    await app.close();
    expect(triggerRuntime.close).toHaveBeenCalledOnce();
  });

  it('fails startup and closes resources when database readiness fails', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const unavailableDatabase: WorkspaceDatabase = {
      ...database,
      checkCompatibility: vi
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
    const telemetry: TelemetryLifecycle = {
      enabled: true,
      started: true,
      start: vi.fn(),
      shutdown,
    };
    const app = await createWorkerApplication(
      workerConfig,
      dependencies(database, telemetry),
    );

    await app.close();

    expect(shutdown).toHaveBeenCalledOnce();
  });
});
