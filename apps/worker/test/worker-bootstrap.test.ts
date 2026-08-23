import type {
  OutboxDispatcherDatabase,
  WorkspaceDatabase,
} from '@pertexo/database';
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
import { NestWorkspaceDatabase } from '../src/platform/database/database.module.js';
import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';
import { WorkerReadiness } from '../src/runtime/worker-readiness.js';

const database: WorkspaceDatabase = {
  withWorkspace: async <T>(
    _workspaceId: string,
    operation: (transaction: never) => Promise<T>,
  ): Promise<T> => operation(undefined as never),
  checkReadiness: () =>
    Promise.resolve({
      migrationHead: '0000_rls_probe.sql',
      postgresMajor: 18,
      role: 'pertexo_worker',
    }),
  close: () => Promise.resolve(),
};

const workerConfig = {
  coordinator: { maximumAdmissions: 32 },
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
  });

  it('creates a standalone context without an HTTP server', async () => {
    const selected = dependencies();
    const app = await createWorkerApplication(workerConfig, selected);

    try {
      expect('getHttpServer' in app).toBe(false);
      expect(selected.workerProcessStart).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('counts each newly composed worker process instance', async () => {
    const selected = dependencies();
    const first = await createWorkerApplication(workerConfig, selected);
    await first.close();
    const restarted = await createWorkerApplication(workerConfig, selected);

    try {
      expect(selected.workerProcessStart).toHaveBeenCalledTimes(2);
    } finally {
      await restarted.close();
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
