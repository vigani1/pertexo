import type { Provider } from '@nestjs/common';
import {
  createFailureNotificationStore,
  createWorkspaceInvitationDeliveryStore,
  type FailureNotificationStore,
  type WorkspaceInvitationDeliveryStore,
} from '@pertexo/database/execution';
import {
  createApplicationSecretEnvelope,
  createAwsConnectionEnvelopeEncryption,
  createNodeSecureHttpClient,
  createResendClient,
  createSlackClient,
  type AwsConnectionEnvelopeEncryptionRuntime,
} from '@pertexo/integrations/server';
import { JOB_NAME, type QueueConsumerObserver } from '@pertexo/queue';

import type { WorkerConfig } from '../config/worker-config.js';
import { boundedBackgroundTask } from '../runtime/background-task-deadline.js';
import { createProviderFailureNotificationDelivery } from '../execution/failure-notification-delivery.js';
import { createWorkspaceInvitationDeliveryHandler } from '../execution/workspace-invitation-delivery.js';
import {
  createPreviewMaintenanceRuntime,
  type PreviewMaintenanceRuntime,
} from '../execution/preview-maintenance-runtime.js';
import {
  PREVIEW_MAINTENANCE_RUNTIME,
  QUEUE_CONSUMER_OBSERVER,
  type TransportModuleDependencies,
} from './transport-tokens.js';

export type PreviewMaintenanceCompositionFactories = Readonly<{
  notificationDelivery: Readonly<{
    store: typeof createFailureNotificationStore;
    encryption: typeof createAwsConnectionEnvelopeEncryption;
    httpClient: typeof createNodeSecureHttpClient;
    slack: typeof createSlackClient;
    email: typeof createResendClient;
    create: typeof createProviderFailureNotificationDelivery;
  }>;
  invitationDelivery: Readonly<{
    store: typeof createWorkspaceInvitationDeliveryStore;
    envelope: typeof createApplicationSecretEnvelope;
    httpClient: typeof createNodeSecureHttpClient;
    email: typeof createResendClient;
    create: typeof createWorkspaceInvitationDeliveryHandler;
  }>;
  runtime: typeof createPreviewMaintenanceRuntime;
}>;

const productionFactories: PreviewMaintenanceCompositionFactories = {
  notificationDelivery: {
    store: createFailureNotificationStore,
    encryption: createAwsConnectionEnvelopeEncryption,
    httpClient: createNodeSecureHttpClient,
    slack: createSlackClient,
    email: createResendClient,
    create: createProviderFailureNotificationDelivery,
  },
  invitationDelivery: {
    store: createWorkspaceInvitationDeliveryStore,
    envelope: createApplicationSecretEnvelope,
    httpClient: createNodeSecureHttpClient,
    email: createResendClient,
    create: createWorkspaceInvitationDeliveryHandler,
  },
  runtime: createPreviewMaintenanceRuntime,
};

type MaintenanceJobSelection = Readonly<{
  notification: boolean;
  reconciliation: boolean;
  replay: boolean;
  unknownOutcome: boolean;
  workspaceInvitation: boolean;
}>;

export function previewMaintenanceRuntimeProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: PREVIEW_MAINTENANCE_RUNTIME,
    inject: [QUEUE_CONSUMER_OBSERVER],
    useFactory: (
      observer: QueueConsumerObserver,
    ): Promise<PreviewMaintenanceRuntime | undefined> =>
      createOwnedPreviewMaintenanceRuntime(config, dependencies, observer),
  };
}

export async function createOwnedPreviewMaintenanceRuntime(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
  observer: QueueConsumerObserver,
  factories: PreviewMaintenanceCompositionFactories = productionFactories,
): Promise<PreviewMaintenanceRuntime | undefined> {
  if (dependencies.previewMaintenanceRuntime !== undefined)
    return dependencies.previewMaintenanceRuntime;
  if (dependencies.dispatchConsumerCapabilities !== undefined) return undefined;
  const jobs = selectMaintenanceJobs(config.outboxDispatcher.enabledJobNames);
  if (!hasMaintenanceJobs(jobs)) return undefined;
  if (
    jobs.notification &&
    dependencies.failureNotificationDelivery === undefined &&
    config.connectionEncryption === undefined
  )
    throw new TypeError(
      'Failure notification dispatch requires connection encryption',
    );

  let notificationStore: FailureNotificationStore | undefined;
  let invitationStore: WorkspaceInvitationDeliveryStore | undefined;
  let encryptionRuntime: AwsConnectionEnvelopeEncryptionRuntime | undefined;
  const deliveryFactories = factories.notificationDelivery;
  try {
    let failureNotificationDelivery = dependencies.failureNotificationDelivery;
    if (jobs.notification && failureNotificationDelivery === undefined) {
      notificationStore = deliveryFactories.store(
        config.database,
        dependencies.databaseRuntime,
      );
      const encryptionConfig = config.connectionEncryption;
      if (encryptionConfig === undefined)
        throw new TypeError(
          'Failure notification dispatch requires connection encryption',
        );
      encryptionRuntime = deliveryFactories.encryption(encryptionConfig);
      const httpClient = deliveryFactories.httpClient();
      failureNotificationDelivery = deliveryFactories.create({
        store: notificationStore,
        encryption: encryptionRuntime.encryption,
        slack: deliveryFactories.slack(httpClient),
        email: deliveryFactories.email(httpClient),
        workerId: config.nodeAttempt.workerId,
      });
    }
    if (jobs.notification && failureNotificationDelivery === undefined)
      throw new TypeError(
        'Failure notification dispatch composition is incomplete',
      );
    let workspaceInvitationDelivery;
    if (jobs.workspaceInvitation) {
      const invitationConfig = config.invitationDelivery;
      if (invitationConfig === undefined)
        throw new TypeError(
          'Workspace invitation dispatch requires system email configuration',
        );
      const invitationFactories = factories.invitationDelivery;
      invitationStore = invitationFactories.store(
        config.database,
        dependencies.databaseRuntime,
      );
      workspaceInvitationDelivery = invitationFactories.create({
        store: invitationStore,
        envelope: invitationFactories.envelope(
          invitationConfig.tokenEncryption,
        ),
        email: invitationFactories.email(invitationFactories.httpClient()),
        apiKey: invitationConfig.apiKey,
        fromEmail: invitationConfig.fromEmail,
        webOrigin: invitationConfig.webOrigin,
        timeoutMillis: invitationConfig.timeoutMillis,
      });
    }
    const runtime = await factories.runtime({
      database: config.database,
      ...(dependencies.databaseRuntime === undefined
        ? {}
        : { databaseRuntime: dependencies.databaseRuntime }),
      observer,
      previewReconciliation: jobs.reconciliation,
      redisUrl: config.redisUrl,
      unknownOutcomeReconciliation: jobs.unknownOutcome,
      runReplay: jobs.replay,
      releaseCohort: config.nodeCompatibilityCohort,
      ...(failureNotificationDelivery === undefined
        ? {}
        : { failureNotificationDelivery }),
      ...(workspaceInvitationDelivery === undefined
        ? {}
        : { workspaceInvitationDelivery }),
    });
    return wrapOwnedRuntime(
      runtime,
      notificationStore,
      encryptionRuntime,
      invitationStore,
      config.outboxDispatcher.operationTimeoutMillis,
    );
  } catch (error: unknown) {
    const cleanup = await closeDeliveryDependencies(
      notificationStore,
      encryptionRuntime,
      invitationStore,
      config.outboxDispatcher.operationTimeoutMillis,
    );
    if (cleanup.length > 0)
      throw new AggregateError(
        [error, ...cleanup],
        'Preview maintenance construction and cleanup failed',
      );
    throw error;
  }
}

function selectMaintenanceJobs(
  jobNames: readonly string[],
): MaintenanceJobSelection {
  return {
    reconciliation: jobNames.includes(JOB_NAME.reconcilePreviewAttempt),
    notification: jobNames.includes(JOB_NAME.deliverRunFailureNotification),
    unknownOutcome: jobNames.includes(JOB_NAME.reconcileUnknownOutcome),
    replay: jobNames.includes(JOB_NAME.replayWorkflowRun),
    workspaceInvitation: jobNames.includes(JOB_NAME.deliverWorkspaceInvitation),
  };
}

function hasMaintenanceJobs(jobs: MaintenanceJobSelection): boolean {
  return (
    jobs.reconciliation ||
    jobs.notification ||
    jobs.unknownOutcome ||
    jobs.replay ||
    jobs.workspaceInvitation
  );
}

function wrapOwnedRuntime(
  runtime: PreviewMaintenanceRuntime,
  notificationStore: FailureNotificationStore | undefined,
  encryptionRuntime: AwsConnectionEnvelopeEncryptionRuntime | undefined,
  invitationStore: WorkspaceInvitationDeliveryStore | undefined,
  timeoutMillis: number,
): PreviewMaintenanceRuntime {
  if (
    notificationStore === undefined &&
    encryptionRuntime === undefined &&
    invitationStore === undefined
  )
    return runtime;
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    consumer: runtime.consumer,
    checkReadiness: () => runtime.checkReadiness(),
    whenIdle: () => runtime.whenIdle(),
    close: (): Promise<void> => {
      closePromise ??= (async (): Promise<void> => {
        const runtimeResult = await Promise.allSettled([
          Promise.resolve().then(() => runtime.close()),
        ]);
        const runtimeFailure = runtimeResult.flatMap((result) =>
          result.status === 'rejected' ? [result.reason as unknown] : [],
        );
        if (runtimeFailure.length > 0) {
          const deferredDependencies = runtime
            .whenIdle()
            .then(() =>
              closeDeliveryDependencies(
                notificationStore,
                encryptionRuntime,
                invitationStore,
                timeoutMillis,
              ),
            );
          let dependencyFailures: readonly unknown[];
          try {
            dependencyFailures = await boundedBackgroundTask(
              deferredDependencies,
              timeoutMillis,
            );
          } catch (error: unknown) {
            observeTask(
              deferredDependencies.then((failures) => {
                if (failures.length > 0)
                  throw new AggregateError(
                    failures,
                    'Preview maintenance deferred owner shutdown failed',
                  );
              }),
            );
            throw new AggregateError(
              [...runtimeFailure, error],
              'Preview maintenance owner shutdown failed',
            );
          }
          throw new AggregateError(
            [...runtimeFailure, ...dependencyFailures],
            'Preview maintenance owner shutdown failed',
          );
        }
        const dependencyFailures = await closeDeliveryDependencies(
          notificationStore,
          encryptionRuntime,
          invitationStore,
          timeoutMillis,
        );
        const failures = [...dependencyFailures];
        if (failures.length > 0)
          throw new AggregateError(
            failures,
            'Preview maintenance owner shutdown failed',
          );
      })();
      return closePromise;
    },
  });
}

async function closeDeliveryDependencies(
  notificationStore: FailureNotificationStore | undefined,
  encryptionRuntime: AwsConnectionEnvelopeEncryptionRuntime | undefined,
  invitationStore: WorkspaceInvitationDeliveryStore | undefined,
  timeoutMillis?: number,
): Promise<readonly unknown[]> {
  const operations = [
    Promise.resolve().then(() => notificationStore?.close()),
    Promise.resolve().then(() => encryptionRuntime?.close()),
    Promise.resolve().then(() => invitationStore?.close()),
  ].map((operation) =>
    timeoutMillis === undefined
      ? operation
      : boundedBackgroundTask(operation, timeoutMillis),
  );
  const results = await Promise.allSettled(operations);
  return results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
}

function observeTask(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}
