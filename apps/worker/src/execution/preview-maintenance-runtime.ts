import {
  createDatabaseOperatorRunReplayStore,
  createOperatorRunReplayHandler,
} from './operator-run-replay-runtime.js';
import {
  createFailureNotificationStore,
  type DatabaseConfig,
  type DatabaseRuntime,
  type FailureNotificationStore,
  type OperatorRunReplayStore,
} from '@pertexo/database/execution';
import type { PlatformReleaseCohort } from '@pertexo/node-catalog';
import { createQueueTraceRunner } from '@pertexo/observability';
import {
  createQueueConsumer,
  InvalidQueueDeliveryError,
  JOB_NAME,
  QUEUE_NAME,
  type QueueConsumer,
  type QueueConsumerObserver,
  type QueueConsumerOptions,
} from '@pertexo/queue';

import {
  createDatabasePreviewReconciliationStore,
  createPreviewReconciliationHandler,
  mapPreviewReconciliationError,
  type PreviewReconciliationStore,
} from './preview-reconciliation-runtime.js';
import type { PreviewTelemetry } from './preview-telemetry.js';
import {
  createDatabaseUnknownOutcomeReconciliationStore,
  createUnknownOutcomeReconciliationHandler,
  mapUnknownOutcomeReconciliationError,
  type UnknownOutcomeReconciliationStore,
} from './unknown-outcome-reconciliation-runtime.js';
import {
  createFailureNotificationHandler,
  type FailureNotificationDeliveryCapability,
  type FailureNotificationHandler,
} from './failure-notification-handler.js';
import {
  closePreviewMaintenanceDependencies,
  createPreviewMaintenanceLifecycle,
  type PreviewMaintenanceComposition,
} from './preview-maintenance-lifecycle.js';

export interface PreviewMaintenanceRuntime {
  readonly consumer: QueueConsumer;
  checkReadiness(): Promise<void>;
  whenIdle(): Promise<void>;
  close(): Promise<void>;
}

export type PreviewMaintenanceCompositionFactories = Readonly<{
  consumer: typeof createQueueConsumer;
  notifications: Readonly<{
    handler: typeof createFailureNotificationHandler;
    store: typeof createFailureNotificationStore;
  }>;
  preview: Readonly<{
    handler: typeof createPreviewReconciliationHandler;
    store: typeof createDatabasePreviewReconciliationStore;
  }>;
  replay: Readonly<{
    handler: typeof createOperatorRunReplayHandler;
    store: typeof createDatabaseOperatorRunReplayStore;
  }>;
  traceRunner: typeof createQueueTraceRunner;
  unknownOutcome: Readonly<{
    handler: typeof createUnknownOutcomeReconciliationHandler;
    store: typeof createDatabaseUnknownOutcomeReconciliationStore;
  }>;
}>;

const productionFactories: PreviewMaintenanceCompositionFactories = {
  consumer: createQueueConsumer,
  notifications: {
    handler: createFailureNotificationHandler,
    store: createFailureNotificationStore,
  },
  preview: {
    handler: createPreviewReconciliationHandler,
    store: createDatabasePreviewReconciliationStore,
  },
  replay: {
    handler: createOperatorRunReplayHandler,
    store: createDatabaseOperatorRunReplayStore,
  },
  traceRunner: createQueueTraceRunner,
  unknownOutcome: {
    handler: createUnknownOutcomeReconciliationHandler,
    store: createDatabaseUnknownOutcomeReconciliationStore,
  },
};

type PreviewMaintenanceOptions = Readonly<{
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
  unknownOutcomeReconciliation?: boolean;
  runReplay?: boolean;
  releaseCohort?: PlatformReleaseCohort;
}>;

type PreviewMaintenanceDependencies = Readonly<{
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

type MaintenanceHandlers = Readonly<{
  failureNotification?: FailureNotificationHandler;
  reconciliation?: ReturnType<typeof createPreviewReconciliationHandler>;
  replay?: ReturnType<typeof createOperatorRunReplayHandler>;
  unknownOutcome?: ReturnType<typeof createUnknownOutcomeReconciliationHandler>;
}>;

export async function createPreviewMaintenanceRuntime(
  options: PreviewMaintenanceOptions,
  dependencies: PreviewMaintenanceDependencies = {},
  factories: PreviewMaintenanceCompositionFactories = productionFactories,
): Promise<PreviewMaintenanceRuntime> {
  const bounds = maintenanceBounds(options);
  const composition = await composeMaintenanceRuntime(
    options,
    dependencies,
    factories,
    bounds,
  );
  return createPreviewMaintenanceLifecycle(
    composition,
    bounds.backgroundTaskShutdownTimeoutMillis,
  );
}

function maintenanceBounds(
  options: PreviewMaintenanceOptions,
): MaintenanceBounds {
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
  options: PreviewMaintenanceOptions,
  dependencies: PreviewMaintenanceDependencies,
  factories: PreviewMaintenanceCompositionFactories,
  bounds: MaintenanceBounds,
): Promise<PreviewMaintenanceComposition> {
  const traceRunner = factories.traceRunner();
  let reconciliationStore:
    (PreviewReconciliationStore & { close?: () => Promise<void> }) | undefined;
  let failureNotificationStore: FailureNotificationStore | undefined;
  let unknownOutcomeStore:
    | (UnknownOutcomeReconciliationStore & { close?: () => Promise<void> })
    | undefined;
  let runReplayStore: OperatorRunReplayStore | undefined;
  let failureNotification: FailureNotificationHandler | undefined;
  let consumer: QueueConsumer | undefined;
  try {
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
        factories.replay.store(
          options.database,
          options.releaseCohort,
          options.databaseRuntime,
        );

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
    };
    consumer = (dependencies.consumerFactory ?? factories.consumer)({
      queueName: QUEUE_NAME.maintenance,
      redisUrl: options.redisUrl,
      handler: maintenanceDeliveryHandler(handlers),
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      traceRunner,
    });
  } catch (error: unknown) {
    const cleanup = await closePreviewMaintenanceDependencies(
      {
        reconciliationStore,
        unknownOutcomeStore,
        runReplayStore,
        failureNotificationStore,
      },
      bounds.backgroundTaskShutdownTimeoutMillis,
    );
    if (cleanup.length > 0)
      throw new AggregateError(
        [error, ...cleanup],
        'Preview maintenance construction and cleanup failed',
      );
    throw error;
  }

  return {
    consumer,
    ...(failureNotification === undefined ? {} : { failureNotification }),
    stores: {
      ...(reconciliationStore === undefined ? {} : { reconciliationStore }),
      ...(failureNotificationStore === undefined
        ? {}
        : { failureNotificationStore }),
      ...(unknownOutcomeStore === undefined ? {} : { unknownOutcomeStore }),
      ...(runReplayStore === undefined ? {} : { runReplayStore }),
    },
  };
}

function maintenanceDeliveryHandler(
  handlers: MaintenanceHandlers,
): QueueConsumerOptions['handler'] {
  return async (delivery, context): Promise<void> => {
    switch (delivery.name) {
      case JOB_NAME.reconcilePreviewAttempt:
        if (handlers.reconciliation === undefined)
          throw new InvalidQueueDeliveryError(
            'Preview reconciliation is not enabled',
          );
        try {
          await handlers.reconciliation.handle(delivery, context);
        } catch (error: unknown) {
          throw mapPreviewReconciliationError(error);
        }
        return;
      case JOB_NAME.reconcileUnknownOutcome:
        if (handlers.unknownOutcome === undefined)
          throw new InvalidQueueDeliveryError(
            'Unknown-outcome reconciliation is not enabled',
          );
        try {
          await handlers.unknownOutcome.handle(delivery, context);
        } catch (error: unknown) {
          throw mapUnknownOutcomeReconciliationError(error);
        }
        return;
      case JOB_NAME.replayWorkflowRun:
        if (handlers.replay === undefined)
          throw new InvalidQueueDeliveryError('Run replay is not enabled');
        await handlers.replay.handle(delivery, context);
        return;
      case JOB_NAME.deliverRunFailureNotification:
        if (handlers.failureNotification === undefined)
          throw new InvalidQueueDeliveryError(
            'Failure notification delivery is not enabled',
          );
        await handlers.failureNotification.handle(delivery, context);
        return;
      default:
        throw new InvalidQueueDeliveryError(
          `Preview maintenance cannot handle ${delivery.name}`,
        );
    }
  };
}
