import type { Provider } from '@nestjs/common';
import { createFailureNotificationStore } from '@pertexo/database/execution';
import {
  createAwsConnectionEnvelopeEncryption,
  createNodeSecureHttpClient,
  createResendClient,
  createSlackClient,
} from '@pertexo/integrations/server';
import { JOB_NAME, type QueueConsumerObserver } from '@pertexo/queue';

import type { WorkerConfig } from '../config/worker-config.js';
import { createProviderFailureNotificationDelivery } from '../execution/failure-notification-delivery.js';
import {
  createPreviewMaintenanceRuntime,
  type PreviewMaintenanceRuntime,
} from '../execution/preview-maintenance-runtime.js';
import {
  PREVIEW_MAINTENANCE_RUNTIME,
  QUEUE_CONSUMER_OBSERVER,
  type TransportModuleDependencies,
} from './transport-tokens.js';

export function previewMaintenanceRuntimeProvider(
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
      const notificationEnabled = jobNames.includes(
        JOB_NAME.deliverRunFailureNotification,
      );
      const unknownOutcomeEnabled = jobNames.includes(
        JOB_NAME.reconcileUnknownOutcome,
      );
      const runReplayEnabled = jobNames.includes(JOB_NAME.replayWorkflowRun);
      if (
        !reconciliationEnabled &&
        !notificationEnabled &&
        !unknownOutcomeEnabled &&
        !runReplayEnabled
      )
        return undefined;
      if (
        notificationEnabled &&
        dependencies.failureNotificationDelivery === undefined &&
        config.connectionEncryption === undefined
      )
        throw new TypeError(
          'Failure notification dispatch requires connection encryption',
        );
      const notificationStore =
        notificationEnabled &&
        dependencies.failureNotificationDelivery === undefined
          ? createFailureNotificationStore(config.database)
          : undefined;
      const encryptionRuntime =
        notificationStore === undefined ||
        config.connectionEncryption === undefined
          ? undefined
          : createAwsConnectionEnvelopeEncryption(config.connectionEncryption);
      const httpClient =
        encryptionRuntime === undefined
          ? undefined
          : createNodeSecureHttpClient();
      const failureNotificationDelivery =
        dependencies.failureNotificationDelivery ??
        (notificationStore === undefined ||
        encryptionRuntime === undefined ||
        httpClient === undefined
          ? undefined
          : createProviderFailureNotificationDelivery({
              store: notificationStore,
              encryption: encryptionRuntime.encryption,
              slack: createSlackClient(httpClient),
              email: createResendClient(httpClient),
              workerId: config.nodeAttempt.workerId,
            }));
      if (notificationEnabled && failureNotificationDelivery === undefined)
        throw new TypeError(
          'Failure notification dispatch composition is incomplete',
        );
      let runtime: PreviewMaintenanceRuntime;
      try {
        runtime = await createPreviewMaintenanceRuntime({
          database: config.database,
          observer,
          redisUrl: config.redisUrl,
          unknownOutcomeReconciliation: unknownOutcomeEnabled,
          runReplay: runReplayEnabled,
          releaseCohort: config.nodeCompatibilityCohort,
          ...(failureNotificationDelivery === undefined
            ? {}
            : { failureNotificationDelivery }),
        });
      } catch (error: unknown) {
        await Promise.allSettled([
          notificationStore?.close(),
          Promise.resolve(encryptionRuntime?.close()),
        ]);
        throw error;
      }
      if (notificationStore === undefined && encryptionRuntime === undefined)
        return runtime;
      return Object.freeze({
        consumer: runtime.consumer,
        close: async (): Promise<void> => {
          const results = await Promise.allSettled([
            runtime.close(),
            notificationStore?.close(),
            Promise.resolve(encryptionRuntime?.close()),
          ]);
          const failure = results.find(
            (result) => result.status === 'rejected',
          );
          if (failure?.status === 'rejected') throw failure.reason;
        },
      });
    },
  };
}
