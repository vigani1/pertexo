import { sealFailureAlert } from '../../mail/failure-alert-content.js';
import { createMailEnvelope } from '../../config/mail-settings.js';
import type { FailureNotificationMailSealer } from '@pertexo/core/notifications';
import { createSmtpEmailClient } from '../../providers/smtp-email.js';
import { StartupSettingError } from '@pertexo/observability/startup';
import type { Provider } from '@nestjs/common';
import type { FailureNotificationStore } from '@pertexo/core/notifications';
import type { WorkspaceInvitationDeliveryStore } from '@pertexo/core/tenant-access';
import type { ConnectionEnvelopeEncryptionRuntime } from '@pertexo/secrets/server';
import type { QueueConsumerObserver } from '@pertexo/queue/server';

import type { WorkerConfig } from '../../config/worker.js';
import { closeOwners } from '../../runtime/scanner.js';
import { failureNotificationDeliveryFactories } from '../../notifications/failure-composition.js';
import { workspaceInvitationDeliveryFactories } from '../../mail/invitation-delivery.js';
import {
  createMaintenanceRuntime,
  type MaintenanceRuntime,
} from '../../maintenance/maintenance.runtime.js';
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
): Readonly<{ notification: boolean; invitation: boolean }> {
  return {
    notification:
      config.connectionEncryption !== undefined ||
      config.systemMailDelivery?.noticeSender !== undefined,
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
  let notificationStore: FailureNotificationStore | undefined;
  let invitationStore: WorkspaceInvitationDeliveryStore | undefined;
  let encryptionRuntime: ConnectionEnvelopeEncryptionRuntime | undefined;
  const deliveryFactories = factories.notificationDelivery;
  try {
    let failureNotificationDelivery;
    let failureNotificationSystemMail:
      FailureNotificationMailSealer | undefined;
    const mail = config.systemMailDelivery;
    const sender = mail?.noticeSender;
    if (mail !== undefined && sender !== undefined) {
      const envelope = createMailEnvelope(
        mail.encryption,
        'AUTH_MAIL_KEY',
        'AUTH_MAIL_PREVIOUS_KEYS',
      );
      failureNotificationSystemMail = (input) =>
        sealFailureAlert(
          envelope,
          sender.fromEmail,
          sender.publicWebOrigin,
          input,
        );
      failureNotificationDelivery = {
        deliver: () =>
          Promise.resolve({
            kind: 'definite_failure' as const,
            safeErrorCode: 'delivery.connection_unavailable',
            possiblyDispatched: false as const,
          }),
      };
    }
    const encryptionConfig = config.connectionEncryption;
    if (encryptionConfig !== undefined) {
      if (config.publicWebOrigin === undefined)
        throw new StartupSettingError(
          'PUBLIC_WEB_ORIGIN',
          'http_origin_required',
        );
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
        smtp: createSmtpEmailClient(
          config.smtpPolicy ?? {
            allowedPrivateNetworks: [],
            allowPlaintext: false,
          },
        ),
        workerId: config.nodeAttempt.workerId,
        publicWebOrigin: config.publicWebOrigin,
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
        email: invitationFactories.email(invitationConfig.delivery),
        fromEmail: invitationConfig.fromEmail,
        webOrigin: invitationConfig.webOrigin,
        timeoutMillis: invitationConfig.timeoutMillis,
      });
    }
    return await factories.runtime({
      database: config.database,
      maintenanceDatabase: config.retention.maintenanceDatabase,
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
      ...(failureNotificationSystemMail === undefined
        ? {}
        : { failureNotificationSystemMail }),
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
