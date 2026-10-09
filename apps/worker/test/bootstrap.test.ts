import type {
  OutboxDispatcherDatabase,
  WorkspaceDatabase,
  WorkspaceTransaction,
  WorkspaceTransactionOptions,
} from '@pertexo/database/testing';
import type { QueueConsumer, QueueProducer } from '@pertexo/queue';
import type {
  StructuredLogger,
  TelemetryLifecycle,
  TransportMetrics,
} from '@pertexo/observability';
import { describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/unbound-method -- assertions target injected seam fakes */

import { createWorkerApplication } from '../src/app.js';
import type { CoordinatorRuntime } from '../src/runs/runtime.js';
import type { NodeAttemptRuntime } from '../src/attempts/runtime.js';
import type { MaintenanceRuntime } from '../src/maintenance/runtime.js';
import type { TriggerRuntime } from '../src/triggers/runtime.js';
import type { RetentionRuntime } from '../src/retention/runtime.js';
import type { WorkflowAutoPauseRuntime } from '../src/workflows/auto-pause-runtime.js';
import { NestWorkspaceDatabase } from '../src/platform/database/database.module.js';
import { WorkerDrainState } from '../src/runtime/shutdown/drain-state.js';
import { WorkerReadiness } from '../src/runtime/health/readiness.js';

const database: WorkspaceDatabase = {
  withWorkspace: async <T>(
    _workspaceId: string,
    operation: (transaction: never) => Promise<T>,
  ): Promise<T> => operation(undefined as never),
  checkReadiness: () =>
    Promise.resolve({
      migrationHead: '0000_rls_probe.sql',
      postgresMajor: 18,
      role: 'pertexo_app',
    }),
  close: () => Promise.resolve(),
};

const workerConfig = {
  coordinator: {
    dueWakeupBatchSize: 25,
    dueWakeupPollIntervalMillis: 250,
    maximumAdmissions: 32,
  },
  workspaceInbox: {
    foldBatchSize: 500,
    foldPollMillis: 1_000,
  },
  workflowAutoPause: {
    foldBatchSize: 500,
    foldPollMillis: 1_000,
  },
  nodeAttempt: {
    heartbeatIntervalMillis: 10_000,
    leaseDurationSeconds: 30,
    workerId: 'worker-test',
  },
  database: {
    connectionString: 'postgresql://pertexo_app:secret@localhost:5432/pertexo',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 5,
    ownerRole: 'pertexo_owner',
  },
  dispatcherDatabase: {
    connectionString:
      'postgresql://pertexo_maintenance:secret@localhost:5432/pertexo',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 2,
    ownerRole: 'pertexo_owner',
  },
  nodeEnv: 'test' as const,
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
  artifactStore: {
    accessKeyId: 'local-access',
    bucket: 'pertexo-artifacts',
    endpoint: 'http://localhost:9090',
    forcePathStyle: true,
    maxObjectBytes: 10_485_760,
    region: 'us-east-1',
    requestTimeoutMs: 5_000,
    secretAccessKey: 'local-secret',
  },
  retention: {
    maintenanceDatabase: {
      connectionString:
        'postgresql://pertexo_maintenance:secret@localhost:5432/pertexo',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 2,
      ownerRole: 'pertexo_owner',
    },
  },
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

function idleConsumer(): QueueConsumer {
  return {
    close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
    isReady: vi.fn().mockReturnValue(true),
    waitUntilReady: vi.fn().mockResolvedValue(undefined),
  };
}

/** Every worker runtime is always composed; these stand in for them. */
function idleRuntimes() {
  const coordinatorRuntime: CoordinatorRuntime = {
    consumer: idleConsumer(),
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const nodeAttemptRuntime: NodeAttemptRuntime = {
    consumer: idleConsumer(),
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const maintenanceRuntime: MaintenanceRuntime = {
    consumer: idleConsumer(),
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    whenIdle: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const triggerRuntime: TriggerRuntime = {
    consumer: idleConsumer(),
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const workflowAutoPauseRuntime = {
    start: vi.fn(),
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkflowAutoPauseRuntime;
  const retentionRuntime = {
    start: vi.fn(),
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as RetentionRuntime;
  return {
    coordinatorRuntime,
    nodeAttemptRuntime,
    maintenanceRuntime,
    triggerRuntime,
    workflowAutoPauseRuntime,
    retentionRuntime,
  };
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
  const workspaceInboxRuntime = {
    start: vi.fn(),
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const runtimes = idleRuntimes();
  return {
    ...runtimes,
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
    workspaceInboxRuntime,
  };
}

describe('worker application bootstrap', () => {
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
    expect(selected.workflowAutoPauseRuntime.close).toHaveBeenCalledOnce();
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
