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
import type { QueueConsumerObserver } from '@pertexo/queue';

import type { WorkerConfig } from '../config/worker-config.js';
import { WorkerDrainState } from '../runtime/worker-drain-state.js';
import type { DispatchConsumerCapabilityRegistry } from './dispatch-consumer-capabilities.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';
import { createQueueMetricsObserver } from './transport-metrics-adapter.js';

export const OUTBOX_DISPATCHER = Symbol('OUTBOX_DISPATCHER');
export const QUEUE_CONSUMER_OBSERVER = Symbol('QUEUE_CONSUMER_OBSERVER');
export const TRANSPORT_METRICS = Symbol('TRANSPORT_METRICS');

export type TransportModuleDependencies = Readonly<{
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
    private readonly drainState: WorkerDrainState,
  ) {}

  public beforeApplicationShutdown(): void {
    this.drainState.beginDrain();
  }

  public async onApplicationShutdown(): Promise<void> {
    await this.dispatcher.close();
  }
}

function dispatcherProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: OUTBOX_DISPATCHER,
    inject: [WorkerDrainState, TRANSPORT_METRICS],
    useFactory: (
      drainState: WorkerDrainState,
      metrics: TransportMetrics,
    ): OutboxDispatcher =>
      new OutboxDispatcher(
        dependencies.dispatcherDatabase ??
          createOutboxDispatcherDatabase(config.dispatcherDatabase),
        dependencies.queueProducer ??
          createQueueProducer({ redisUrl: config.redisUrl }),
        drainState,
        config.outboxDispatcher,
        metrics,
        dependencies.dispatchConsumerCapabilities,
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
        provider,
        OutboxDispatcherLifecycle,
      ],
      exports: [WorkerDrainState, metricsProvider, observerProvider, provider],
    };
  }
}
