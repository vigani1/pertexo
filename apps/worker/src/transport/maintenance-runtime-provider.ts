import type { Provider } from '@nestjs/common';
import type {
  FailureNotificationStore,
  WorkspaceInvitationDeliveryStore,
} from '@pertexo/database/execution';
import type { AwsConnectionEnvelopeEncryptionRuntime } from '@pertexo/integrations/server';
import { JOB_NAME, type QueueConsumerObserver } from '@pertexo/queue';

import type { WorkerConfig } from '../config/worker-config.js';
import {
  wrapOwnedMaintenanceRuntime,
  closeDeliveryDependencies,
} from './maintenance-owned-delivery.js';
import { failureNotificationDeliveryFactories } from '../execution/failure-notification-composition.js';
import { workspaceInvitationDeliveryFactories } from '../execution/workspace-invitation-delivery.js';
import {
  createMaintenanceRuntime,
  type MaintenanceRuntime,
} from '../maintenance/runtime.js';
import {
  MAINTENANCE_RUNTIME,
  QUEUE_CONSUMER_OBSERVER,
  type TransportModuleDependencies,
} from './transport-tokens.js';

export type MaintenanceProviderFactories = Readonly<{
  notificationDelivery: typeof failureNotificationDeliveryFactories;
  invitationDelivery: typeof workspaceInvitationDeliveryFactories;
  runtime: typeof createMaintenanceRuntime;
}>;

const productionFactories: MaintenanceProviderFactories = {
  notificationDelivery: failureNotificationDeliveryFactories,
  invitationDelivery: workspaceInvitationDeliveryFactories,
  runtime: createMaintenanceRuntime,
};

type MaintenanceJobSelection = Readonly<{
  notification: boolean;
  reconciliation: boolean;
  replay: boolean;
  unknownOutcome: boolean;
  workspaceInvitation: boolean;
}>;

export function maintenanceRuntimeProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: MAINTENANCE_RUNTIME,
    inject: [QUEUE_CONSUMER_OBSERVER],
    useFactory: (
      observer: QueueConsumerObserver,
    ): Promise<MaintenanceRuntime | undefined> =>
      createOwnedMaintenanceRuntime(config, dependencies, observer),
  };
}

export async function createOwnedMaintenanceRuntime(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
  observer: QueueConsumerObserver,
  factories: MaintenanceProviderFactories = productionFactories,
): Promise<MaintenanceRuntime | undefined> {
  if (dependencies.maintenanceRuntime !== undefined)
    return dependencies.maintenanceRuntime;
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
    return wrapOwnedMaintenanceRuntime(
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
        'Maintenance construction and cleanup failed',
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
