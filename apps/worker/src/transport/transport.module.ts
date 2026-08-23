import type {
  BeforeApplicationShutdown,
  DynamicModule,
  OnApplicationShutdown,
  Provider,
} from '@nestjs/common';
import { Inject, Injectable, Module } from '@nestjs/common';
import {
  createOutboxDispatcherDatabase,
  type OutboxDispatcherDatabase,
} from '@pertexo/database';
import {
  createTransportMetrics,
  type TransportMetrics,
} from '@pertexo/observability/transport-metrics';
import { platformServingRegistryRelease } from '@pertexo/node-catalog';
import { createPlatformNodeRegistryForRelease } from '@pertexo/node-catalog/server';
import { createQueueProducer, type QueueProducer } from '@pertexo/queue';
import { JOB_NAME, type QueueConsumerObserver } from '@pertexo/queue';

import type { WorkerConfig } from '../config/worker-config.js';
import {
  createCoordinatorRuntime,
  type CoordinatorRuntime,
} from '../execution/coordinator-runtime.js';
import {
  createNodeAttemptRuntime,
  type NodeAttemptRuntime,
} from '../execution/node-attempt-runtime.js';
import {
  createDatabasePreviewAttemptRunStore,
  createPlatformPreviewNodeInvoker,
} from '../execution/preview-attempt-runtime.js';
import {
  createPreviewMaintenanceRuntime,
  type PreviewMaintenanceRuntime,
} from '../execution/preview-maintenance-runtime.js';
import { WorkerDrainState } from '../runtime/worker-drain-state.js';
import {
  createDispatchConsumerCapabilityRegistry,
  type DispatchConsumerCapabilityRegistry,
} from './dispatch-consumer-capabilities.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';
import { createQueueMetricsObserver } from './transport-metrics-adapter.js';

export const OUTBOX_DISPATCHER = Symbol('OUTBOX_DISPATCHER');
export const QUEUE_CONSUMER_OBSERVER = Symbol('QUEUE_CONSUMER_OBSERVER');
export const TRANSPORT_METRICS = Symbol('TRANSPORT_METRICS');
export const COORDINATOR_RUNTIME = Symbol('COORDINATOR_RUNTIME');
export const NODE_ATTEMPT_RUNTIME = Symbol('NODE_ATTEMPT_RUNTIME');
export const PREVIEW_MAINTENANCE_RUNTIME = Symbol(
  'PREVIEW_MAINTENANCE_RUNTIME',
);
export const DISPATCH_CONSUMER_CAPABILITIES = Symbol(
  'DISPATCH_CONSUMER_CAPABILITIES',
);

export type TransportModuleDependencies = Readonly<{
  coordinatorRuntime?: CoordinatorRuntime;
  nodeAttemptRuntime?: NodeAttemptRuntime;
  previewMaintenanceRuntime?: PreviewMaintenanceRuntime;
  dispatchConsumerCapabilities?: DispatchConsumerCapabilityRegistry;
  dispatcherDatabase?: OutboxDispatcherDatabase;
  queueProducer?: QueueProducer;
  transportMetrics?: TransportMetrics;
}>;

@Injectable()
class OutboxDispatcherLifecycle
  implements BeforeApplicationShutdown, OnApplicationShutdown
{
  public constructor(
    @Inject(OUTBOX_DISPATCHER)
    private readonly dispatcher: OutboxDispatcher,
    @Inject(COORDINATOR_RUNTIME)
    private readonly coordinatorRuntime: CoordinatorRuntime | undefined,
    @Inject(NODE_ATTEMPT_RUNTIME)
    private readonly nodeAttemptRuntime: NodeAttemptRuntime | undefined,
    @Inject(PREVIEW_MAINTENANCE_RUNTIME)
    private readonly previewMaintenanceRuntime:
      PreviewMaintenanceRuntime | undefined,
    private readonly drainState: WorkerDrainState,
  ) {}

  public beforeApplicationShutdown(): void {
    this.drainState.beginDrain();
  }

  public async onApplicationShutdown(): Promise<void> {
    const results = await Promise.allSettled([
      this.dispatcher.close(),
      ...(this.coordinatorRuntime === undefined
        ? []
        : [this.coordinatorRuntime.close()]),
      ...(this.nodeAttemptRuntime === undefined
        ? []
        : [this.nodeAttemptRuntime.close()]),
      ...(this.previewMaintenanceRuntime === undefined
        ? []
        : [this.previewMaintenanceRuntime.close()]),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}

function previewMaintenanceRuntimeProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: PREVIEW_MAINTENANCE_RUNTIME,
    inject: [QUEUE_CONSUMER_OBSERVER],
    useFactory: async (
      observer: QueueConsumerObserver,
    ): Promise<PreviewMaintenanceRuntime | undefined> => {
      if (dependencies.previewMaintenanceRuntime !== undefined)
        return dependencies.previewMaintenanceRuntime;
      if (dependencies.dispatchConsumerCapabilities !== undefined)
        return undefined;
      const jobNames = config.outboxDispatcher.enabledJobNames;
      const reconciliationEnabled = jobNames.includes(
        JOB_NAME.reconcilePreviewAttempt,
      );
      const cleanupEnabled = jobNames.includes(JOB_NAME.sweepExpiredPreviews);
      if (!reconciliationEnabled && !cleanupEnabled) return undefined;
      if (cleanupEnabled && config.artifactStore === undefined)
        throw new TypeError(
          'Preview cleanup requires the artifact-store capability',
        );
      return createPreviewMaintenanceRuntime({
        ...(cleanupEnabled && config.artifactStore !== undefined
          ? { artifactStore: config.artifactStore }
          : {}),
        database: config.database,
        observer,
        redisUrl: config.redisUrl,
      });
    },
  };
}

function nodeAttemptRuntimeProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: NODE_ATTEMPT_RUNTIME,
    inject: [QUEUE_CONSUMER_OBSERVER],
    useFactory: async (
      observer: QueueConsumerObserver,
    ): Promise<NodeAttemptRuntime | undefined> => {
      if (dependencies.nodeAttemptRuntime !== undefined)
        return dependencies.nodeAttemptRuntime;
      if (dependencies.dispatchConsumerCapabilities !== undefined)
        return undefined;
      const enabledJobNames = config.outboxDispatcher.enabledJobNames;
      const nodeAttemptEnabled = enabledJobNames.includes(
        JOB_NAME.executeNodeAttempt,
      );
      const previewEnabled = enabledJobNames.includes(
        JOB_NAME.executePreviewAttempt,
      );
      if (!nodeAttemptEnabled && !previewEnabled) return undefined;
      let previewRunStore:
        ReturnType<typeof createDatabasePreviewAttemptRunStore> | undefined;
      try {
        if (previewEnabled) {
          previewRunStore = createDatabasePreviewAttemptRunStore(
            config.database,
          );
        }
        return await composeNodeAttemptRuntime(
          config,
          dependencies,
          observer,
          previewEnabled && previewRunStore !== undefined
            ? { runStore: previewRunStore }
            : undefined,
        );
      } catch (error: unknown) {
        await previewRunStore?.close();
        throw error;
      }
    },
  };
}

async function composeNodeAttemptRuntime(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
  observer: QueueConsumerObserver,
  preview:
    | Readonly<{
        runStore: ReturnType<typeof createDatabasePreviewAttemptRunStore>;
      }>
    | undefined,
): Promise<NodeAttemptRuntime | undefined> {
  return createNodeAttemptRuntime({
    ...(config.artifactStore === undefined
      ? {}
      : { artifactStore: config.artifactStore }),
    ...(config.connectionEncryption === undefined
      ? {}
      : { connectionEncryption: config.connectionEncryption }),
    database: config.database,
    heartbeatIntervalMillis: config.nodeAttempt.heartbeatIntervalMillis,
    leaseDurationSeconds: config.nodeAttempt.leaseDurationSeconds,
    observer,
    ...(preview === undefined
      ? {}
      : {
          preview: {
            invoker: createPlatformPreviewNodeInvoker({
              releaseCohort: config.nodeCompatibilityCohort,
              registry: createPlatformNodeRegistryForRelease(
                platformServingRegistryRelease(config.nodeCompatibilityCohort),
              ),
            }),
            runStore: preview.runStore,
          },
        }),
    releaseCohort: config.nodeCompatibilityCohort,
    redisUrl: config.redisUrl,
    workerId: config.nodeAttempt.workerId,
  });
}

function dispatcherProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: OUTBOX_DISPATCHER,
    inject: [
      WorkerDrainState,
      TRANSPORT_METRICS,
      DISPATCH_CONSUMER_CAPABILITIES,
    ],
    useFactory: (
      drainState: WorkerDrainState,
      metrics: TransportMetrics,
      consumerCapabilities: DispatchConsumerCapabilityRegistry,
    ): OutboxDispatcher =>
      new OutboxDispatcher(
        dependencies.dispatcherDatabase ??
          createOutboxDispatcherDatabase(config.dispatcherDatabase),
        dependencies.queueProducer ??
          createQueueProducer({ redisUrl: config.redisUrl }),
        drainState,
        config.outboxDispatcher,
        metrics,
        consumerCapabilities,
      ),
  };
}

function coordinatorRuntimeProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: COORDINATOR_RUNTIME,
    inject: [QUEUE_CONSUMER_OBSERVER],
    useFactory: async (
      observer: QueueConsumerObserver,
    ): Promise<CoordinatorRuntime | undefined> => {
      if (dependencies.coordinatorRuntime !== undefined)
        return dependencies.coordinatorRuntime;
      if (
        dependencies.dispatchConsumerCapabilities !== undefined ||
        !config.outboxDispatcher.enabledJobNames.includes(
          JOB_NAME.advanceWorkflowRun,
        )
      )
        return undefined;
      return createCoordinatorRuntime({
        database: config.database,
        maximumAdmissions: config.coordinator.maximumAdmissions,
        observer,
        releaseCohort: config.nodeCompatibilityCohort,
        redisUrl: config.redisUrl,
      });
    },
  };
}

function dispatchCapabilitiesProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: DISPATCH_CONSUMER_CAPABILITIES,
    inject: [
      COORDINATOR_RUNTIME,
      NODE_ATTEMPT_RUNTIME,
      PREVIEW_MAINTENANCE_RUNTIME,
    ],
    useFactory: (
      runtime: CoordinatorRuntime | undefined,
      nodeAttemptRuntime: NodeAttemptRuntime | undefined,
      previewMaintenanceRuntime: PreviewMaintenanceRuntime | undefined,
    ): DispatchConsumerCapabilityRegistry =>
      dependencies.dispatchConsumerCapabilities ??
      createDispatchConsumerCapabilityRegistry([
        ...(runtime === undefined
          ? []
          : [
              {
                jobName: JOB_NAME.advanceWorkflowRun,
                consumer: runtime.consumer,
              } as const,
            ]),
        ...(nodeAttemptRuntime === undefined
          ? []
          : [
              ...(config.outboxDispatcher.enabledJobNames.includes(
                JOB_NAME.executeNodeAttempt,
              )
                ? [
                    {
                      jobName: JOB_NAME.executeNodeAttempt,
                      consumer: nodeAttemptRuntime.consumer,
                    } as const,
                  ]
                : []),
              ...(config.outboxDispatcher.enabledJobNames.includes(
                JOB_NAME.executePreviewAttempt,
              )
                ? [
                    {
                      jobName: JOB_NAME.executePreviewAttempt,
                      consumer: nodeAttemptRuntime.consumer,
                    } as const,
                  ]
                : []),
            ]),
        ...(previewMaintenanceRuntime === undefined ||
        !config.outboxDispatcher.enabledJobNames.includes(
          JOB_NAME.reconcilePreviewAttempt,
        )
          ? []
          : [
              {
                jobName: JOB_NAME.reconcilePreviewAttempt,
                consumer: previewMaintenanceRuntime.consumer,
              } as const,
            ]),
        ...(previewMaintenanceRuntime === undefined ||
        !config.outboxDispatcher.enabledJobNames.includes(
          JOB_NAME.sweepExpiredPreviews,
        )
          ? []
          : [
              {
                jobName: JOB_NAME.sweepExpiredPreviews,
                consumer: previewMaintenanceRuntime.consumer,
              } as const,
            ]),
      ]),
  };
}

@Module({})
// Nest requires a class as the module identity passed through dynamic registration.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class TransportModule {
  public static register(
    config: WorkerConfig,
    dependencies: TransportModuleDependencies = {},
  ): DynamicModule {
    const runtimeProvider = coordinatorRuntimeProvider(config, dependencies);
    const attemptRuntimeProvider = nodeAttemptRuntimeProvider(
      config,
      dependencies,
    );
    const maintenanceRuntimeProvider = previewMaintenanceRuntimeProvider(
      config,
      dependencies,
    );
    const capabilitiesProvider = dispatchCapabilitiesProvider(
      config,
      dependencies,
    );
    const provider = dispatcherProvider(config, dependencies);
    const metricsProvider: Provider = {
      provide: TRANSPORT_METRICS,
      useFactory: (): TransportMetrics =>
        dependencies.transportMetrics ?? createTransportMetrics(),
    };
    const observerProvider: Provider = {
      provide: QUEUE_CONSUMER_OBSERVER,
      inject: [TRANSPORT_METRICS],
      useFactory: (metrics: TransportMetrics): QueueConsumerObserver =>
        createQueueMetricsObserver(metrics),
    };
    return {
      module: TransportModule,
      providers: [
        WorkerDrainState,
        metricsProvider,
        observerProvider,
        runtimeProvider,
        attemptRuntimeProvider,
        maintenanceRuntimeProvider,
        capabilitiesProvider,
        provider,
        OutboxDispatcherLifecycle,
      ],
      exports: [WorkerDrainState, metricsProvider, observerProvider, provider],
    };
  }
}
