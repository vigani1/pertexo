import { errorWorkflowFactories } from '../notifications/error-workflow.js';
import type { OperatorRunReplayStore } from '@pertexo/core/operator';
import type { ErrorWorkflowStore } from '@pertexo/core/runs';
import { operatorRunReplayFactories } from '../operator/run-replay.js';
import {
  connectionHealthObservationFactories,
  type ConnectionHealthObservationStore,
} from '../connections/health-runtime.js';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import type { FailureNotificationStore } from '@pertexo/core/notifications';
import type { PreviewReconciliationStore } from '@pertexo/core/previews';
import { createQueueTraceRunner } from '@pertexo/observability';
import {
  createQueueConsumer,
  QUEUE_NAME,
  type QueueConsumer,
  type QueueConsumerObserver,
} from '@pertexo/queue';

import { previewReconciliationFactories } from '../previews/reconciliation.js';
import {
  unknownOutcomeReconciliationFactories,
  type UnknownOutcomeReconciliationStore,
} from '../attempts/delivery/unknown-outcome-reconciliation.js';
import type {
  FailureNotificationDeliveryCapability,
  FailureNotificationHandler,
} from '../notifications/failure-handler.js';
import { failureNotificationFactories } from '../notifications/failure-composition.js';
import {
  closeOwners,
  createScannerRuntime,
  type Owner,
  type ScannerRuntime,
} from '../runtime/scanner.js';
import type { WorkspaceInvitationDeliveryHandler } from '../identity/invitation-delivery.js';
import {
  maintenanceDeliveryHandler,
  type MaintenanceHandlers,
} from './delivery-handler.js';

export type MaintenanceRuntime = ScannerRuntime;

export type MaintenanceRuntimeFactories = Readonly<{
  connectionHealth: typeof connectionHealthObservationFactories;
  errorWorkflows: typeof errorWorkflowFactories;
  consumer: typeof createQueueConsumer;
  notifications: Readonly<{
    handler: typeof failureNotificationFactories.handler;
    store: typeof failureNotificationFactories.store;
  }>;
  preview: Readonly<{
    handler: typeof previewReconciliationFactories.handler;
    store: typeof previewReconciliationFactories.store;
  }>;
  replay: Readonly<{
    handler: typeof operatorRunReplayFactories.handler;
    store: typeof operatorRunReplayFactories.store;
  }>;
  traceRunner: typeof createQueueTraceRunner;
  unknownOutcome: Readonly<{
    handler: typeof unknownOutcomeReconciliationFactories.handler;
    store: typeof unknownOutcomeReconciliationFactories.store;
  }>;
}>;

const productionFactories: MaintenanceRuntimeFactories = {
  connectionHealth: connectionHealthObservationFactories,
  errorWorkflows: errorWorkflowFactories,
  consumer: createQueueConsumer,
  notifications: failureNotificationFactories,
  preview: previewReconciliationFactories,
  replay: operatorRunReplayFactories,
  traceRunner: createQueueTraceRunner,
  unknownOutcome: unknownOutcomeReconciliationFactories,
};

type MaintenanceOptions = Readonly<{
  database: DatabaseConfig;
  databaseRuntime?: DatabaseRuntime;
  backgroundTaskShutdownTimeoutMillis?: number;
  observer?: QueueConsumerObserver;
  redisUrl: string;
  failureNotificationDelivery?: FailureNotificationDeliveryCapability;
  workspaceInvitationDelivery?: WorkspaceInvitationDeliveryHandler;
  /** Resources the deliveries use; the runtime closes them once built. */
  deliveryOwners?: readonly Owner[];
}>;

// Each provider call gets 30 seconds; a failed one retries twice, 30 seconds
// apart.
const FAILURE_NOTIFICATION_DELIVERY = Object.freeze({
  timeoutMillis: 30_000,
  maxAttempts: 3,
  retryDelaySeconds: 30,
});

export async function createMaintenanceRuntime(
  options: MaintenanceOptions,
  overrides: Partial<MaintenanceRuntimeFactories> = {},
): Promise<MaintenanceRuntime> {
  const factories = { ...productionFactories, ...overrides };
  const shutdownTimeoutMillis =
    options.backgroundTaskShutdownTimeoutMillis ?? 5_000;
  const traceRunner = factories.traceRunner();
  let reconciliationStore:
    (PreviewReconciliationStore & { close?: () => Promise<void> }) | undefined;
  let failureNotificationStore: FailureNotificationStore | undefined;
  let unknownOutcomeStore:
    | (UnknownOutcomeReconciliationStore & { close?: () => Promise<void> })
    | undefined;
  let runReplayStore: OperatorRunReplayStore | undefined;
  let connectionHealthStore: ConnectionHealthObservationStore | undefined;
  let failureNotification: FailureNotificationHandler | undefined;
  let consumer: QueueConsumer | undefined;
  let errorWorkflowStore: ErrorWorkflowStore | undefined;
  try {
    connectionHealthStore = factories.connectionHealth.store(
      options.database,
      options.databaseRuntime,
    );
    reconciliationStore = factories.preview.store(
      options.database,
      options.databaseRuntime,
    );
    if (options.failureNotificationDelivery !== undefined) {
      failureNotificationStore = factories.notifications.store(
        options.database,
        options.databaseRuntime,
      );
      failureNotification = factories.notifications.handler({
        store: failureNotificationStore,
        delivery: options.failureNotificationDelivery,
        ...FAILURE_NOTIFICATION_DELIVERY,
      });
    }
    unknownOutcomeStore = factories.unknownOutcome.store(
      options.database,
      options.databaseRuntime,
    );
    runReplayStore = factories.replay.store(
      options.database,
      options.databaseRuntime,
    );

    errorWorkflowStore = factories.errorWorkflows.store(
      options.database,
      options.databaseRuntime,
    );
    const handlers: MaintenanceHandlers = {
      errorWorkflow: factories.errorWorkflows.handler(errorWorkflowStore),
      connectionHealth: factories.connectionHealth.handler(
        connectionHealthStore,
      ),
      reconciliation: factories.preview.handler(reconciliationStore),
      unknownOutcome: factories.unknownOutcome.handler(unknownOutcomeStore),
      replay: factories.replay.handler(runReplayStore),
      ...(failureNotification === undefined ? {} : { failureNotification }),
      ...(options.workspaceInvitationDelivery === undefined
        ? {}
        : { workspaceInvitation: options.workspaceInvitationDelivery }),
    };
    consumer = factories.consumer({
      queueName: QUEUE_NAME.maintenance,
      redisUrl: options.redisUrl,
      handler: maintenanceDeliveryHandler(handlers),
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      traceRunner,
    });
  } catch (error: unknown) {
    const cleanup = await closeOwners(
      [
        errorWorkflowStore,
        connectionHealthStore,
        reconciliationStore,
        unknownOutcomeStore,
        runReplayStore,
        failureNotificationStore,
      ],
      shutdownTimeoutMillis,
    );
    if (cleanup.length > 0)
      throw new AggregateError(
        [error, ...cleanup],
        'Maintenance construction and cleanup failed',
      );
    throw error;
  }

  const healthStore = connectionHealthStore;
  const recoveryStore = failureNotificationStore;
  const notifications = failureNotification;
  return createScannerRuntime({
    name: 'Maintenance',
    consumer,
    owners: [
      errorWorkflowStore,
      connectionHealthStore,
      reconciliationStore,
      unknownOutcomeStore,
      runReplayStore,
      failureNotificationStore,
      ...(options.deliveryOwners ?? []),
    ],
    // Recovers failure-notification deliveries whose worker stopped.
    pollIntervalMillis: 1_000,
    shutdownTimeoutMillis,
    scan: async (signal) => {
      await recoveryStore?.recoverDue(25, 3, signal);
    },
    checkReadiness: async () => {
      await healthStore.checkReadiness?.();
    },
    afterConsumerClose: async () => {
      const settled = await Promise.allSettled(
        notifications?.pendingOperations() ?? [],
      );
      const failures = settled.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          'Failure notification deliveries did not settle',
        );
    },
  });
}
