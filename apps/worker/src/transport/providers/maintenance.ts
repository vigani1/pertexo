import type { Provider } from '@nestjs/common';
import type { FailureNotificationStore } from '@pertexo/database/notifications';
import type { WorkspaceInvitationDeliveryStore } from '@pertexo/database/tenant-access';
import type { AwsConnectionEnvelopeEncryptionRuntime } from '@pertexo/integrations/server';
import type { QueueConsumerObserver } from '@pertexo/queue';

import type { WorkerConfig } from '../../config/worker.js';
import { closeOwners } from '../../runtime/scanner.js';
import { failureNotificationDeliveryFactories } from '../../notifications/failure-composition.js';
import { workspaceInvitationDeliveryFactories } from '../../identity/invitation-delivery.js';
import {
  createMaintenanceRuntime,
  type MaintenanceRuntime,
} from '../../maintenance/runtime.js';
import {
  MAINTENANCE_RUNTIME,
  QUEUE_CONSUMER_OBSERVER,
  type TransportModuleDependencies,
} from '../tokens.js';

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

/** Which deliveries this worker can make: each needs its own configuration. */
export function maintenanceDeliveries(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): Readonly<{ notification: boolean; invitation: boolean }> {
  return {
    notification:
      dependencies.failureNotificationDelivery !== undefined ||
      config.connectionEncryption !== undefined,
    invitation: config.invitationDelivery !== undefined,
  };
}

export function maintenanceRuntimeProvider(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
): Provider {
  return {
    provide: MAINTENANCE_RUNTIME,
    inject: [QUEUE_CONSUMER_OBSERVER],
    useFactory: (
      observer: QueueConsumerObserver,
    ): Promise<MaintenanceRuntime> =>
      createOwnedMaintenanceRuntime(config, dependencies, observer),
  };
}

export async function createOwnedMaintenanceRuntime(
  config: WorkerConfig,
  dependencies: TransportModuleDependencies,
  observer: QueueConsumerObserver,
  factories: MaintenanceProviderFactories = productionFactories,
): Promise<MaintenanceRuntime> {
  if (dependencies.maintenanceRuntime !== undefined)
    return dependencies.maintenanceRuntime;

  let notificationStore: FailureNotificationStore | undefined;
  let invitationStore: WorkspaceInvitationDeliveryStore | undefined;
  let encryptionRuntime: AwsConnectionEnvelopeEncryptionRuntime | undefined;
  const deliveryFactories = factories.notificationDelivery;
  try {
    let failureNotificationDelivery = dependencies.failureNotificationDelivery;
    const encryptionConfig = config.connectionEncryption;
    if (
      failureNotificationDelivery === undefined &&
      encryptionConfig !== undefined
    ) {
      notificationStore = deliveryFactories.store(
        config.database,
        dependencies.databaseRuntime,
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
    let workspaceInvitationDelivery;
    const invitationConfig = config.invitationDelivery;
    if (invitationConfig !== undefined) {
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
    return await factories.runtime({
      database: config.database,
      ...(dependencies.databaseRuntime === undefined
        ? {}
        : { databaseRuntime: dependencies.databaseRuntime }),
      observer,
      redisUrl: config.redisUrl,
      ...(failureNotificationDelivery === undefined
        ? {}
        : { failureNotificationDelivery }),
      ...(workspaceInvitationDelivery === undefined
        ? {}
        : { workspaceInvitationDelivery }),
      deliveryOwners: [notificationStore, encryptionRuntime, invitationStore],
    });
  } catch (error: unknown) {
    const cleanup = await closeOwners(
      [notificationStore, encryptionRuntime, invitationStore],
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
