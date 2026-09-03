import type { DynamicModule, Provider } from '@nestjs/common';
import { Module } from '@nestjs/common';

import type { WorkerConfig } from '../config/worker-config.js';
import { WorkerDrainState } from '../runtime/worker-drain-state.js';
import { coordinatorRuntimeProvider } from './coordinator-runtime-provider.js';
import {
  dispatchCapabilitiesProvider,
  dispatcherProvider,
  queueObserverProvider,
  transportMetricsProvider,
} from './dispatch-providers.js';
import { nodeAttemptRuntimeProvider } from './node-attempt-runtime-provider.js';
import { previewMaintenanceRuntimeProvider } from './preview-maintenance-runtime-provider.js';
import { OutboxDispatcherLifecycle } from './transport-lifecycle.js';
import {
  NODE_ATTEMPT_RUNTIME,
  TRIGGER_RUNTIME,
  type TransportModuleDependencies,
} from './transport-tokens.js';
import { triggerRuntimeProvider } from './trigger-runtime-provider.js';

export {
  NODE_ATTEMPT_RUNTIME,
  OUTBOX_DISPATCHER,
  TRANSPORT_METRICS,
  TRIGGER_RUNTIME,
} from './transport-tokens.js';

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
      previewMaintenanceRuntimeProvider(config, dependencies),
      triggerRuntimeProvider(config, dependencies),
      dispatchCapabilitiesProvider(config, dependencies),
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
        NODE_ATTEMPT_RUNTIME,
        TRIGGER_RUNTIME,
      ],
    };
  }
}
