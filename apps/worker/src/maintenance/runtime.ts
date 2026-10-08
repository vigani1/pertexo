import { operatorRunReplayFactories } from '../execution/operator-run-replay-runtime.js';
import {
  connectionHealthObservationFactories,
  type ConnectionHealthObservationStore,
} from '../execution/connection-health-runtime.js';
import type { ConnectionRunHealthMode } from '../config/connection-run-health-config.js';
import type {
  DatabaseConfig,
  DatabaseRuntime,
  FailureNotificationStore,
  OperatorRunReplayStore,
  PreviewReconciliationStore,
} from '@pertexo/database/execution';
import { createQueueTraceRunner } from '@pertexo/observability';
import {
  createQueueConsumer,
  QUEUE_NAME,
  type QueueConsumer,
  type QueueConsumerObserver,
} from '@pertexo/queue';

import { previewReconciliationFactories } from '../execution/preview-reconciliation-runtime.js';
import type { PreviewTelemetry } from '../execution/preview-telemetry.js';
import {
  unknownOutcomeReconciliationFactories,
  type UnknownOutcomeReconciliationStore,
} from '../execution/unknown-outcome-reconciliation-runtime.js';
import type {
  FailureNotificationDeliveryCapability,
  FailureNotificationHandler,
} from '../execution/failure-notification-handler.js';
import { failureNotificationFactories } from '../execution/failure-notification-composition.js';
import {
  closeMaintenanceDependencies,
  createMaintenanceLifecycle,
  type MaintenanceComposition,
} from './lifecycle.js';
import type { WorkspaceInvitationDeliveryHandler } from '../execution/workspace-invitation-delivery.js';
import {
  maintenanceDeliveryHandler,
  type MaintenanceHandlers,
} from './delivery-handler.js';

export interface MaintenanceRuntime {
  readonly consumer: QueueConsumer;
  checkReadiness(): Promise<void>;
  whenIdle(): Promise<void>;
  close(): Promise<void>;
}

export type MaintenanceRuntimeFactories = Readonly<{
  connectionHealth: typeof connectionHealthObservationFactories;
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
  consumer: createQueueConsumer,
  notifications: failureNotificationFactories,
  preview: previewReconciliationFactories,
  replay: operatorRunReplayFactories,
  traceRunner: createQueueTraceRunner,
  unknownOutcome: unknownOutcomeReconciliationFactories,
};

type MaintenanceOptions = Readonly<{
  connectionHealthApplication?: boolean;
  connectionRunHealthMode?: ConnectionRunHealthMode;
  database: DatabaseConfig;
  databaseRuntime?: DatabaseRuntime;
  backgroundTaskShutdownTimeoutMillis?: number;
  observer?: QueueConsumerObserver;
  previewReconciliation?: boolean;
  redisUrl: string;
  failureNotificationDelivery?: FailureNotificationDeliveryCapability;
  failureNotificationDeliveryTimeoutMillis?: number;
  failureNotificationMaxAttempts?: number;
  failureNotificationRetryDelaySeconds?: number;
  workspaceInvitationDelivery?: WorkspaceInvitationDeliveryHandler;
  unknownOutcomeReconciliation?: boolean;
  runReplay?: boolean;
}>;

type MaintenanceDependencies = Readonly<{
  connectionHealthStore?: ConnectionHealthObservationStore;
  consumerFactory?: typeof createQueueConsumer;
  reconciliationStore?: PreviewReconciliationStore & {
    close?: () => Promise<void>;
  };
  previewTelemetry?: PreviewTelemetry;
  failureNotificationStore?: FailureNotificationStore;
  unknownOutcomeStore?: UnknownOutcomeReconciliationStore & {
    close?: () => Promise<void>;
  };
  runReplayStore?: OperatorRunReplayStore;
}>;

type MaintenanceBounds = Readonly<{
  backgroundTaskShutdownTimeoutMillis: number;
  failureNotificationDeliveryTimeoutMillis: number;
  failureNotificationMaxAttempts: number;
  failureNotificationRetryDelaySeconds: number;
}>;

export async function createMaintenanceRuntime(
  options: MaintenanceOptions,
  dependencies: MaintenanceDependencies = {},
  factories: MaintenanceRuntimeFactories = productionFactories,
): Promise<MaintenanceRuntime> {
  const bounds = maintenanceBounds(options);
  const composition = await composeMaintenanceRuntime(
    options,
    dependencies,
    factories,
    bounds,
  );
  return createMaintenanceLifecycle(
    composition,
    bounds.backgroundTaskShutdownTimeoutMillis,
  );
}

function maintenanceBounds(options: MaintenanceOptions): MaintenanceBounds {
  const backgroundTaskShutdownTimeoutMillis =
    options.backgroundTaskShutdownTimeoutMillis ?? 5_000;
  const failureNotificationDeliveryTimeoutMillis =
    options.failureNotificationDeliveryTimeoutMillis ?? 30_000;
  const failureNotificationMaxAttempts =
    options.failureNotificationMaxAttempts ?? 3;
  const failureNotificationRetryDelaySeconds =
    options.failureNotificationRetryDelaySeconds ?? 30;
  if (
    !Number.isSafeInteger(backgroundTaskShutdownTimeoutMillis) ||
    backgroundTaskShutdownTimeoutMillis < 1 ||
    backgroundTaskShutdownTimeoutMillis > 120_000
  )
    throw new TypeError(
      'Background task shutdown timeout must be between 1 and 120000',
    );
  if (
    !Number.isSafeInteger(failureNotificationDeliveryTimeoutMillis) ||
    failureNotificationDeliveryTimeoutMillis < 1 ||
    failureNotificationDeliveryTimeoutMillis > 120_000 ||
    !Number.isSafeInteger(failureNotificationMaxAttempts) ||
    failureNotificationMaxAttempts < 1 ||
    failureNotificationMaxAttempts > 100 ||
    !Number.isSafeInteger(failureNotificationRetryDelaySeconds) ||
    failureNotificationRetryDelaySeconds < 1 ||
    failureNotificationRetryDelaySeconds > 86_400
  )
    throw new TypeError('Failure notification delivery bounds are invalid');

  return {
    backgroundTaskShutdownTimeoutMillis,
    failureNotificationDeliveryTimeoutMillis,
    failureNotificationMaxAttempts,
    failureNotificationRetryDelaySeconds,
  };
}

async function composeMaintenanceRuntime(
  options: MaintenanceOptions,
  dependencies: MaintenanceDependencies,
  factories: MaintenanceRuntimeFactories,
  bounds: MaintenanceBounds,
): Promise<MaintenanceComposition> {
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
  try {
    if (options.connectionHealthApplication === true)
      connectionHealthStore =
        dependencies.connectionHealthStore ??
        factories.connectionHealth.store(
          options.database,
          options.databaseRuntime,
        );
    if (options.previewReconciliation !== false)
      reconciliationStore =
        dependencies.reconciliationStore ??
        factories.preview.store(options.database, options.databaseRuntime);
    if (options.failureNotificationDelivery !== undefined)
      failureNotificationStore =
        dependencies.failureNotificationStore ??
        factories.notifications.store(
          options.database,
          options.databaseRuntime,
        );
    if (options.unknownOutcomeReconciliation === true)
      unknownOutcomeStore =
        dependencies.unknownOutcomeStore ??
        factories.unknownOutcome.store(
          options.database,
          options.databaseRuntime,
        );
    if (options.runReplay === true)
      runReplayStore =
        dependencies.runReplayStore ??
        factories.replay.store(options.database, options.databaseRuntime);

    if (
      options.failureNotificationDelivery !== undefined &&
      failureNotificationStore !== undefined
    )
      failureNotification = factories.notifications.handler({
        store: failureNotificationStore,
        delivery: options.failureNotificationDelivery,
        timeoutMillis: bounds.failureNotificationDeliveryTimeoutMillis,
        maxAttempts: bounds.failureNotificationMaxAttempts,
        retryDelaySeconds: bounds.failureNotificationRetryDelaySeconds,
      });
    const handlers: MaintenanceHandlers = {
      ...(connectionHealthStore === undefined
        ? {}
        : {
            connectionHealth: factories.connectionHealth.handler(
              connectionHealthStore,
              options.connectionRunHealthMode ?? 'off',
            ),
          }),
      ...(reconciliationStore === undefined
        ? {}
        : {
            reconciliation: factories.preview.handler(
              reconciliationStore,
              dependencies.previewTelemetry,
            ),
          }),
      ...(unknownOutcomeStore === undefined
        ? {}
        : {
            unknownOutcome:
              factories.unknownOutcome.handler(unknownOutcomeStore),
          }),
      ...(runReplayStore === undefined
        ? {}
        : { replay: factories.replay.handler(runReplayStore) }),
      ...(failureNotification === undefined ? {} : { failureNotification }),
      ...(options.workspaceInvitationDelivery === undefined
        ? {}
        : { workspaceInvitation: options.workspaceInvitationDelivery }),
    };
    consumer = (dependencies.consumerFactory ?? factories.consumer)({
      queueName: QUEUE_NAME.maintenance,
      redisUrl: options.redisUrl,
      handler: maintenanceDeliveryHandler(handlers),
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      traceRunner,
    });
  } catch (error: unknown) {
    const cleanup = await closeMaintenanceDependencies(
      {
        reconciliationStore,
        unknownOutcomeStore,
        runReplayStore,
        failureNotificationStore,
        connectionHealthStore,
      },
      bounds.backgroundTaskShutdownTimeoutMillis,
    );
    if (cleanup.length > 0)
      throw new AggregateError(
        [error, ...cleanup],
        'Maintenance construction and cleanup failed',
      );
    throw error;
  }

  return {
    consumer,
    ...(failureNotification === undefined ? {} : { failureNotification }),
    stores: {
      ...(connectionHealthStore === undefined ? {} : { connectionHealthStore }),
      ...(reconciliationStore === undefined ? {} : { reconciliationStore }),
      ...(failureNotificationStore === undefined
        ? {}
        : { failureNotificationStore }),
      ...(unknownOutcomeStore === undefined ? {} : { unknownOutcomeStore }),
      ...(runReplayStore === undefined ? {} : { runReplayStore }),
    },
  };
}
