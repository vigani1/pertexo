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
import { createQueueProducer, type QueueProducer } from '@pertexo/queue';
import { JOB_NAME, type QueueConsumerObserver } from '@pertexo/queue';

import type { WorkerConfig } from '../config/worker-config.js';
import {
  createCoordinatorRuntime,
  type CoordinatorRuntime,
} from '../execution/coordinator-runtime.js';
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
export const DISPATCH_CONSUMER_CAPABILITIES = Symbol(
  'DISPATCH_CONSUMER_CAPABILITIES',
);

export type TransportModuleDependencies = Readonly<{
  coordinatorRuntime?: CoordinatorRuntime;
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
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
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
        redisUrl: config.redisUrl,
      });
    },
  };
}

function dispatchCapabilitiesProvider(
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: DISPATCH_CONSUMER_CAPABILITIES,
    inject: [COORDINATOR_RUNTIME],
    useFactory: (
      runtime: CoordinatorRuntime | undefined,
    ): DispatchConsumerCapabilityRegistry =>
      dependencies.dispatchConsumerCapabilities ??
      createDispatchConsumerCapabilityRegistry(
        runtime === undefined
          ? []
          : [
              {
                jobName: JOB_NAME.advanceWorkflowRun,
                consumer: runtime.consumer,
              },
            ],
      ),
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
    const capabilitiesProvider = dispatchCapabilitiesProvider(dependencies);
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
        capabilitiesProvider,
        provider,
        OutboxDispatcherLifecycle,
      ],
      exports: [WorkerDrainState, metricsProvider, observerProvider, provider],
    };
  }
}
