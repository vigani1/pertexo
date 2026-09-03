import {
  createDatabaseOperatorRunReplayStore,
  createOperatorRunReplayHandler,
} from './operator-run-replay-runtime.js';
import {
  createFailureNotificationStore,
  type DatabaseConfig,
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
import { waitForSupervisorDelay } from '../runtime/abortable-delay.js';
import {
  createFailureNotificationHandler,
  type FailureNotificationDeliveryCapability,
} from './failure-notification-handler.js';

export interface PreviewMaintenanceRuntime {
  readonly consumer: QueueConsumer;
  close(): Promise<void>;
}

export async function createPreviewMaintenanceRuntime(
  options: Readonly<{
    database: DatabaseConfig;
    observer?: QueueConsumerObserver;
    redisUrl: string;
    failureNotificationDelivery?: FailureNotificationDeliveryCapability;
    unknownOutcomeReconciliation?: boolean;
    runReplay?: boolean;
    releaseCohort?: PlatformReleaseCohort;
  }>,
  dependencies: Readonly<{
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
  }> = {},
): Promise<PreviewMaintenanceRuntime> {
  const reconciliationStore =
    dependencies.reconciliationStore ??
    createDatabasePreviewReconciliationStore(options.database);
  const failureNotificationStore =
    options.failureNotificationDelivery === undefined
      ? undefined
      : (dependencies.failureNotificationStore ??
        createFailureNotificationStore(options.database));
  const unknownOutcomeStore =
    options.unknownOutcomeReconciliation === true
      ? (dependencies.unknownOutcomeStore ??
        createDatabaseUnknownOutcomeReconciliationStore(options.database))
      : undefined;
  const runReplayStore =
    options.runReplay === true
      ? (dependencies.runReplayStore ??
        createDatabaseOperatorRunReplayStore(
          options.database,
          options.releaseCohort,
        ))
      : undefined;
  const failureNotification =
    options.failureNotificationDelivery === undefined ||
    failureNotificationStore === undefined
      ? undefined
      : createFailureNotificationHandler({
          store: failureNotificationStore,
          delivery: options.failureNotificationDelivery,
          timeoutMillis: 30_000,
          maxAttempts: 3,
          retryDelaySeconds: 30,
        });
  const reconciliation = createPreviewReconciliationHandler(
    reconciliationStore,
    dependencies.previewTelemetry,
  );
  const unknownOutcomeReconciliation =
    unknownOutcomeStore === undefined
      ? undefined
      : createUnknownOutcomeReconciliationHandler(unknownOutcomeStore);
  const runReplay =
    runReplayStore === undefined
      ? undefined
      : createOperatorRunReplayHandler(runReplayStore);
  let consumer: QueueConsumer;
  try {
    consumer = (dependencies.consumerFactory ?? createQueueConsumer)({
      queueName: QUEUE_NAME.maintenance,
      redisUrl: options.redisUrl,
      handler: async (delivery, context): Promise<void> => {
        if (delivery.name === JOB_NAME.reconcilePreviewAttempt) {
          try {
            await reconciliation.handle(delivery, context);
          } catch (error: unknown) {
            throw mapPreviewReconciliationError(error);
          }
          return;
        }
        if (delivery.name === JOB_NAME.reconcileUnknownOutcome) {
          if (unknownOutcomeReconciliation === undefined)
            throw new InvalidQueueDeliveryError(
              'Unknown-outcome reconciliation is not enabled',
            );
          try {
            await unknownOutcomeReconciliation.handle(delivery, context);
          } catch (error: unknown) {
            throw mapUnknownOutcomeReconciliationError(error);
          }
          return;
        }
        if (delivery.name === JOB_NAME.replayWorkflowRun) {
          if (runReplay === undefined)
            throw new InvalidQueueDeliveryError('Run replay is not enabled');
          await runReplay.handle(delivery, context);
          return;
        }
        if (delivery.name === JOB_NAME.deliverRunFailureNotification) {
          if (failureNotification === undefined)
            throw new InvalidQueueDeliveryError(
              'Failure notification delivery is not enabled',
            );
          await failureNotification.handle(delivery, context);
          return;
        }
        throw new InvalidQueueDeliveryError(
          `Preview maintenance cannot handle ${delivery.name}`,
        );
      },
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      traceRunner: createQueueTraceRunner(),
    });
  } catch (error: unknown) {
    await Promise.allSettled([
      reconciliationStore.close?.(),
      unknownOutcomeStore?.close?.(),
      runReplayStore?.close(),
      failureNotificationStore?.close(),
    ]);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const recoveryAbort = new AbortController();
  const recoveryLoop = (async (): Promise<void> => {
    while (!recoveryAbort.signal.aborted) {
      try {
        await failureNotificationStore?.recoverDue(25, 3);
      } catch {
        // PostgreSQL authority is retried; dependency readiness remains fail closed.
      }
      await waitForSupervisorDelay(1_000, recoveryAbort.signal);
    }
  })();
  return Object.freeze({
    consumer,
    close: (): Promise<void> => {
      closePromise ??= (async (): Promise<void> => {
        recoveryAbort.abort();
        const results = await Promise.allSettled([
          consumer.close(),
          recoveryLoop,
          reconciliationStore.close?.(),
          unknownOutcomeStore?.close?.(),
          runReplayStore?.close(),
          failureNotificationStore?.close(),
        ]);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      })();
      return closePromise;
    },
  });
}
