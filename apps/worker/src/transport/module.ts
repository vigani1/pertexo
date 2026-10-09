import type { DynamicModule, Provider } from '@nestjs/common';
import { Module } from '@nestjs/common';

import type { WorkerConfig } from '../config/worker.js';
import { WorkerDrainState } from '../runtime/shutdown/drain-state.js';
import { coordinatorRuntimeProvider } from './providers/coordinator.js';
import {
  dispatcherProvider,
  queueObserverProvider,
  transportMetricsProvider,
} from './providers/dispatcher.js';
import { nodeAttemptRuntimeProvider } from './providers/node-attempts.js';
import { maintenanceRuntimeProvider } from './providers/maintenance.js';
import { OutboxDispatcherLifecycle } from './lifecycle.js';
import {
  COORDINATOR_RUNTIME,
  NODE_ATTEMPT_RUNTIME,
  MAINTENANCE_RUNTIME,
  TRIGGER_RUNTIME,
  type TransportModuleDependencies,
} from './tokens.js';
import { triggerRuntimeProvider } from './providers/triggers.js';

export {
  COORDINATOR_RUNTIME,
  NODE_ATTEMPT_RUNTIME,
  OUTBOX_DISPATCHER,
  MAINTENANCE_RUNTIME,
  TRANSPORT_METRICS,
  TRIGGER_RUNTIME,
} from './tokens.js';

@Module({})
// Nest requires a class as the module identity passed through dynamic registration.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class TransportModule {
  public static register(
    config: WorkerConfig,
    dependencies: TransportModuleDependencies = {},
  ): DynamicModule {
    const metricsProvider = transportMetricsProvider(dependencies);
    const observerProvider = queueObserverProvider();
    const provider = dispatcherProvider(config, dependencies);
    const providers: Provider[] = [
      WorkerDrainState,
      metricsProvider,
      observerProvider,
      coordinatorRuntimeProvider(config, dependencies),
      nodeAttemptRuntimeProvider(config, dependencies),
      maintenanceRuntimeProvider(config, dependencies),
      triggerRuntimeProvider(config, dependencies),
      provider,
      OutboxDispatcherLifecycle,
    ];
    return {
      module: TransportModule,
      providers,
      exports: [
        WorkerDrainState,
        metricsProvider,
        observerProvider,
        provider,
        OutboxDispatcherLifecycle,
        COORDINATOR_RUNTIME,
        NODE_ATTEMPT_RUNTIME,
        MAINTENANCE_RUNTIME,
        TRIGGER_RUNTIME,
      ],
    };
  }
}
