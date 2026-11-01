import { transportMetrics as createTransportMetrics } from '../support/transport/metrics.js';
import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';
import type { OutboxDispatcherDatabase } from '@pertexo/core/testing';
import type { WorkspaceDatabase } from '@pertexo/database/testing';
import type { QueueConsumer, QueueProducer } from '@pertexo/queue';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import { vi } from 'vitest';
import {
  createWorkerApplication as constructWorkerApplication,
  type WorkerApplicationDependencies,
} from '../../src/app.js';
import type { WorkerConfig } from '../../src/config/worker.js';
import {
  workerTestFactories,
  type WorkerTestServices,
} from '../support/worker-application.js';
import type { CoordinatorRuntime } from '../../src/runs/runtime.js';
import type { NodeAttemptRuntime } from '../../src/attempts/delivery/runtime.js';
import type { MaintenanceRuntime } from '../../src/maintenance/runtime.js';
import type { TriggerRuntime } from '../../src/triggers/runtime.js';
import type { RetentionRuntime } from '../../src/retention/runtime.js';
import type { WorkflowAutoPauseRuntime } from '../../src/workflows/auto-pause-runtime.js';

export function createWorkerApplication(
  config: WorkerConfig,
  {
    logger: selectedLogger,
    telemetry,
    ...services
  }: Pick<WorkerApplicationDependencies, 'logger' | 'telemetry'> &
    WorkerTestServices,
) {
  return constructWorkerApplication(
    config,
    { logger: selectedLogger, telemetry },
    workerTestFactories(config, selectedLogger, services),
  );
}

export const database: WorkspaceDatabase = {
  withWorkspace: async <T>(
    _workspaceId: string,
    operation: (transaction: never) => Promise<T>,
  ): Promise<T> => operation(undefined as never),
  applyInstanceCapacity: () => Promise.resolve(),
  checkReadiness: () =>
    Promise.resolve({
      migrationHead: '0000_rls_probe.sql',
      postgresMajor: 18,
      role: 'pertexo_app',
    }),
  close: () => Promise.resolve(),
};

export const workerConfig = {
  httpRequest: { allowedPrivateNetworks: [] },
  codeRunner: {
    settings: DEFAULT_CODE_SETTINGS,
    socketPath: '/tmp/unused-code.sock',
    requireHardened: false,
  },
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
  artifactScratchDirectory: '/var/lib/pertexo/artifact-scratch',
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

export const logger = {
  debug: vi.fn<NonNullable<StructuredLogger['debug']>>(),
  error: vi.fn<NonNullable<StructuredLogger['error']>>(),
  fatal: vi.fn<NonNullable<StructuredLogger['fatal']>>(),
  info: vi.fn<NonNullable<StructuredLogger['info']>>(),
  trace: vi.fn<NonNullable<StructuredLogger['trace']>>(),
  warn: vi.fn<NonNullable<StructuredLogger['warn']>>(),
} satisfies StructuredLogger;

function idleConsumer() {
  return {
    close: vi
      .fn<NonNullable<QueueConsumer['close']>>()
      .mockResolvedValue({ abortedJobs: 0, forced: false }),
    isReady: vi
      .fn<NonNullable<QueueConsumer['isReady']>>()
      .mockReturnValue(true),
    waitUntilReady: vi
      .fn<NonNullable<QueueConsumer['waitUntilReady']>>()
      .mockResolvedValue(undefined),
  } satisfies QueueConsumer;
}

/** Every worker runtime is always composed; these stand in for them. */
function idleRuntimes() {
  const coordinatorRuntime = {
    consumer: idleConsumer(),
    checkReadiness: vi
      .fn<NonNullable<CoordinatorRuntime['checkReadiness']>>()
      .mockResolvedValue(undefined),
    close: vi
      .fn<NonNullable<CoordinatorRuntime['close']>>()
      .mockResolvedValue(undefined),
  } satisfies CoordinatorRuntime;
  const nodeAttemptRuntime = {
    consumer: idleConsumer(),
    checkReadiness: vi
      .fn<NonNullable<NodeAttemptRuntime['checkReadiness']>>()
      .mockResolvedValue(undefined),
    checkObjectStore: vi
      .fn<NonNullable<NodeAttemptRuntime['checkObjectStore']>>()
      .mockResolvedValue(undefined),
    close: vi
      .fn<NonNullable<NodeAttemptRuntime['close']>>()
      .mockResolvedValue(undefined),
  } satisfies NodeAttemptRuntime;
  const maintenanceRuntime = {
    consumer: idleConsumer(),
    checkReadiness: vi
      .fn<NonNullable<MaintenanceRuntime['checkReadiness']>>()
      .mockResolvedValue(undefined),
    close: vi
      .fn<NonNullable<MaintenanceRuntime['close']>>()
      .mockResolvedValue(undefined),
  } satisfies MaintenanceRuntime;
  const triggerRuntime = {
    consumer: idleConsumer(),
    checkReadiness: vi
      .fn<NonNullable<TriggerRuntime['checkReadiness']>>()
      .mockResolvedValue(undefined),
    close: vi
      .fn<NonNullable<TriggerRuntime['close']>>()
      .mockResolvedValue(undefined),
  } satisfies TriggerRuntime;
  const workflowAutoPauseRuntime = {
    start: vi.fn(),
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkflowAutoPauseRuntime;
  const idlePollingRuntime = () => ({
    start: vi.fn(),
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  });
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
    stalledWorkRuntime: idlePollingRuntime(),
  };
}

export function dependencies(
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
  const dispatcherDatabase = {
    checkReadiness: dispatcherReadiness,
    claimBatch: vi
      .fn<NonNullable<OutboxDispatcherDatabase['claimBatch']>>()
      .mockResolvedValue({ events: [] }),
    close: dispatcherClose,
    markPublished: vi
      .fn<NonNullable<OutboxDispatcherDatabase['markPublished']>>()
      .mockResolvedValue(true),
    observeBacklog: vi
      .fn<NonNullable<OutboxDispatcherDatabase['observeBacklog']>>()
      .mockResolvedValue({ backlog: 0 }),
    releaseOrFail: vi
      .fn<NonNullable<OutboxDispatcherDatabase['releaseOrFail']>>()
      .mockResolvedValue('retry_scheduled'),
  } satisfies OutboxDispatcherDatabase;
  const queueProducer = {
    close: queueClose,
    isReady: vi
      .fn<NonNullable<QueueProducer['isReady']>>()
      .mockReturnValue(true),
    observe: vi
      .fn<NonNullable<QueueProducer['observe']>>()
      .mockResolvedValue([]),
    publish: vi.fn<NonNullable<QueueProducer['publish']>>(),
    waitUntilReady: vi
      .fn<NonNullable<QueueProducer['waitUntilReady']>>()
      .mockResolvedValue(undefined),
  } satisfies QueueProducer;
  const metrics = createTransportMetrics();
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
    transportMetrics: metrics,
    workerProcessStart: metrics.recordWorkerProcessStart,
    workspaceInboxRuntime,
  };
}
