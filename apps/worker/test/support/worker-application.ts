import { Test } from '@nestjs/testing';
import { createDatabaseRuntime } from '@pertexo/database/platform';
import type { OutboxDispatcherDatabase } from '@pertexo/core/testing';
import type { WorkspaceDatabase } from '@pertexo/database/testing';
import type {
  StructuredLogger,
  TransportMetrics,
} from '@pertexo/observability';
import type { QueueProducer } from '@pertexo/queue';

import type { WorkerApplicationCompositionFactories } from '../../src/app.js';
import type { NodeAttemptRuntime } from '../../src/attempts/delivery/runtime.js';
import type { WorkerConfig } from '../../src/config/worker.js';
import type { MaintenanceRuntime } from '../../src/maintenance/runtime.js';
import type { WorkspaceInboxRuntime } from '../../src/notifications/inbox-runtime.js';
import { WORKSPACE_INBOX_RUNTIME } from '../../src/notifications/inbox-runtime.js';
import { WORKSPACE_DATABASE } from '../../src/platform/database/module.js';
import {
  RETENTION_RUNTIME,
  type RetentionRuntime,
} from '../../src/retention/runtime.js';
import type { CoordinatorRuntime } from '../../src/runs/runtime.js';
import {
  STALLED_WORK_RUNTIME,
  type StalledWorkRuntime,
} from '../../src/runs/stalled-work.js';
import { WorkerReadiness } from '../../src/runtime/health/readiness.js';
import {
  WorkerReadinessMonitor,
  type WorkerReadinessMarker,
} from '../../src/runtime/health/readiness-monitor.js';
import { WorkerDrainState } from '../../src/runtime/shutdown/drain-state.js';
import {
  COORDINATOR_RUNTIME,
  MAINTENANCE_RUNTIME,
  NODE_ATTEMPT_RUNTIME,
  OUTBOX_DISPATCHER,
  TRANSPORT_METRICS,
  TRIGGER_RUNTIME,
} from '../../src/transport/module.js';
import { OutboxDispatcher } from '../../src/transport/outbox/dispatch/runtime.js';
import { createOwnedOutboxDispatcher } from '../../src/transport/providers/dispatcher.js';
import type { TriggerRuntime } from '../../src/triggers/runtime.js';
import {
  WORKFLOW_AUTO_PAUSE_RUNTIME,
  type WorkflowAutoPauseRuntime,
} from '../../src/workflows/auto-pause-runtime.js';
import { emptyCallbackStore } from './callback-store.js';

/** What a test puts in place of the worker's real services. */
export type WorkerTestServices = Readonly<{
  database?: WorkspaceDatabase;
  dispatcherDatabase?: OutboxDispatcherDatabase;
  queueProducer?: QueueProducer;
  transportMetrics?: TransportMetrics;
  coordinatorRuntime?: CoordinatorRuntime;
  nodeAttemptRuntime?: NodeAttemptRuntime;
  maintenanceRuntime?: MaintenanceRuntime;
  triggerRuntime?: TriggerRuntime;
  workspaceInboxRuntime?: WorkspaceInboxRuntime;
  workflowAutoPauseRuntime?: WorkflowAutoPauseRuntime;
  retentionRuntime?: RetentionRuntime;
  stalledWorkRuntime?: StalledWorkRuntime;
  readinessMarker?: WorkerReadinessMarker;
}>;

/** The worker's real module, with named services replaced through Nest. */
export function workerTestFactories(
  config: WorkerConfig,
  logger: StructuredLogger,
  services: WorkerTestServices,
): WorkerApplicationCompositionFactories {
  return {
    databaseRuntime: createDatabaseRuntime,
    callbackStore: emptyCallbackStore,
    applicationContext: async (module, options) => {
      const builder = Test.createTestingModule({ imports: [module] });
      const values: readonly (readonly [symbol, unknown])[] = [
        [WORKSPACE_DATABASE, services.database],
        [TRANSPORT_METRICS, services.transportMetrics],
        [COORDINATOR_RUNTIME, services.coordinatorRuntime],
        [NODE_ATTEMPT_RUNTIME, services.nodeAttemptRuntime],
        [MAINTENANCE_RUNTIME, services.maintenanceRuntime],
        [TRIGGER_RUNTIME, services.triggerRuntime],
        [WORKSPACE_INBOX_RUNTIME, services.workspaceInboxRuntime],
        [WORKFLOW_AUTO_PAUSE_RUNTIME, services.workflowAutoPauseRuntime],
        [RETENTION_RUNTIME, services.retentionRuntime],
        [STALLED_WORK_RUNTIME, services.stalledWorkRuntime],
      ];
      for (const [token, value] of values)
        if (value !== undefined)
          builder.overrideProvider(token).useValue(value);
      const { dispatcherDatabase, queueProducer, readinessMarker } = services;
      if (dispatcherDatabase !== undefined && queueProducer !== undefined)
        builder.overrideProvider(OUTBOX_DISPATCHER).useFactory({
          inject: [WorkerDrainState, TRANSPORT_METRICS],
          factory: (drainState: WorkerDrainState, metrics: TransportMetrics) =>
            createOwnedOutboxDispatcher(
              config,
              {},
              {
                drainState,
                metrics,
                factories: {
                  database: () => dispatcherDatabase,
                  producer: () => queueProducer,
                  dispatcher: (database, producer, input) =>
                    new OutboxDispatcher(database, producer, input),
                },
              },
            ),
        });
      if (readinessMarker !== undefined)
        builder.overrideProvider(WorkerReadinessMonitor).useFactory({
          inject: [WorkerReadiness],
          factory: (readiness: WorkerReadiness) =>
            new WorkerReadinessMonitor(readiness, logger, {
              marker: readinessMarker,
              failClosed: undefined,
              operationTimeoutMillis:
                config.outboxDispatcher.operationTimeoutMillis,
            }),
        });
      builder.setLogger(options.logger);
      const testing = await builder.compile();
      return testing.init();
    },
  };
}
