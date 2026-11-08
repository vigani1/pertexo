import { createFailureNotificationMailAuthorizer } from '@pertexo/core/notifications';
import { reportUnavailableMailKey } from './mail/report-unavailable-mail-key.js';
import { createSystemMailClient } from './mail/system-mail-client.js';
import { sealNoticeMail } from './mail/notice-content.js';
import 'reflect-metadata';

import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type {
  DatabaseRuntime,
  WorkspaceDatabase,
} from '@pertexo/database/platform';
import { createSystemMailDeliveryStore } from '@pertexo/secrets/server';
import {
  createNoticeMailStore,
  createWorkspaceInboxFoldStore,
} from '@pertexo/core/inbox';
import { createMailEnvelope } from './config/mail-settings.js';
import { RedisWorkspaceInboxHintPublisher } from '@pertexo/queue/server';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability/server';

import type { WorkerConfig } from './config/worker.js';
import { createSystemMailDeliveryHandler } from '@pertexo/secrets/server';
import {
  SYSTEM_MAIL_RUNTIME,
  createSystemMailRuntime,
  type SystemMailRuntime,
} from './mail/system-mail.runtime.js';
import {
  createWorkspaceInboxRuntime,
  WORKSPACE_INBOX_RUNTIME,
  type WorkspaceInboxRuntime,
} from './notifications/inbox-runtime.js';
import {
  WORKFLOW_AUTO_PAUSE_RUNTIME,
  type WorkflowAutoPauseRuntime,
} from './workflows/auto-pause-runtime.js';
import { configuredWorkflowAutoPauseRuntime } from './workflows/auto-pause-provider.js';
import {
  DatabaseModule,
  WORKSPACE_DATABASE,
} from './platform/database/database.module.js';
import { ObservabilityModule } from './platform/observability/observability.module.js';
import { configuredRetentionRuntime } from './retention/composition.js';
import {
  RETENTION_RUNTIME,
  type RetentionRuntime,
} from './retention/retention.runtime.js';
import {
  configuredStalledWorkRuntime,
  STALLED_WORK_RUNTIME,
  type StalledWorkRuntime,
} from './runs/stalled-work.js';
import { WorkerReadiness } from './runtime/health/readiness.js';
import { WorkerReadinessMonitor } from './runtime/health/readiness-monitor.js';
import { WorkerResourceMonitor } from './runtime/health/resource-monitor.js';
import { WorkerDrainState } from './runtime/shutdown/drain-state.js';
import { WorkerProcessKeepalive } from './runtime/process-keepalive.js';
import { WorkerShutdownCoordinator } from './runtime/shutdown/coordinator.js';
import { TransportModule } from './transport/transport.module.js';
import {
  COORDINATOR_RUNTIME,
  MAINTENANCE_RUNTIME,
  NODE_ATTEMPT_RUNTIME,
  TRIGGER_RUNTIME,
} from './transport/tokens.js';
import type { NodeAttemptRuntime } from './attempts/delivery/node-attempt.runtime.js';
import type { MaintenanceRuntime } from './maintenance/maintenance.runtime.js';
import type { CoordinatorRuntime } from './runs/coordinator.runtime.js';
import type { TriggerRuntime } from './triggers/trigger.runtime.js';
import { OutboxDispatcherLifecycle } from './transport/lifecycle.js';

export type WorkerModuleDependencies = Readonly<{
  databaseRuntime?: DatabaseRuntime;
  dispatcherDatabaseRuntime?: DatabaseRuntime;
  logger: StructuredLogger;
  telemetry: TelemetryLifecycle;
}>;

@Module({})
// Nest requires a class as the root module passed to the application factory.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WorkerModule {
  public static register(
    config: WorkerConfig,
    dependencies: WorkerModuleDependencies,
  ): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        DatabaseModule.register(
          config.database,
          dependencies.databaseRuntime === undefined
            ? {}
            : { runtime: dependencies.databaseRuntime },
        ),
        TransportModule.register(config, dependencies),
        ObservabilityModule.register(
          dependencies.logger,
          dependencies.telemetry,
        ),
      ],
      providers: [
        WorkerReadiness,
        WorkerProcessKeepalive,
        WorkerShutdownCoordinator,
        systemMailProvider(config, dependencies),
        {
          provide: WORKSPACE_INBOX_RUNTIME,
          useFactory: (): WorkspaceInboxRuntime =>
            createWorkspaceInboxRuntime(
              createWorkspaceInboxFoldStore(
                config.database,
                dependencies.databaseRuntime,
                config.retention.maintenanceDatabase,
              ),
              new RedisWorkspaceInboxHintPublisher({
                redisUrl: config.redisUrl,
              }),
              config.workspaceInbox,
              {
                cycleFailed: (error) => {
                  dependencies.logger.error(
                    'workspace_inbox.cycle_failed',
                    {},
                    error,
                  );
                },
                hintFailed: () => {
                  dependencies.logger.warn('workspace_inbox.hint_failed');
                },
              },
            ),
        },
        {
          provide: WORKFLOW_AUTO_PAUSE_RUNTIME,
          useFactory: () =>
            configuredWorkflowAutoPauseRuntime(config, dependencies),
        },
        {
          provide: RETENTION_RUNTIME,
          useFactory: (): RetentionRuntime =>
            configuredRetentionRuntime(config, dependencies.logger),
        },
        stalledWorkProvider(config, dependencies),
        {
          provide: WorkerReadinessMonitor,
          inject: [WorkerReadiness],
          useFactory: (readiness: WorkerReadiness): WorkerReadinessMonitor =>
            new WorkerReadinessMonitor(readiness, dependencies.logger, {
              operationTimeoutMillis:
                config.outboxDispatcher.operationTimeoutMillis,
            }),
        },
        {
          provide: WorkerResourceMonitor,
          inject: [WorkerDrainState],
          useFactory: (drainState: WorkerDrainState): WorkerResourceMonitor =>
            new WorkerResourceMonitor(
              config.resourceSafety,
              drainState,
              dependencies.logger,
            ),
        },
        {
          provide: Symbol('WORKER_RESOURCE_OWNERS'),
          inject: [
            WorkerShutdownCoordinator,
            OutboxDispatcherLifecycle,
            WORKSPACE_DATABASE,
            SYSTEM_MAIL_RUNTIME,
            WORKSPACE_INBOX_RUNTIME,
            WORKFLOW_AUTO_PAUSE_RUNTIME,
            RETENTION_RUNTIME,
            STALLED_WORK_RUNTIME,
          ],
          // Nest pairs these parameters with the ordered inject array below.
          // eslint-disable-next-line max-params
          useFactory: (
            shutdown: WorkerShutdownCoordinator,
            transport: OutboxDispatcherLifecycle,
            database: WorkspaceDatabase,
            systemMail: SystemMailRuntime | undefined,
            workspaceInbox: WorkspaceInboxRuntime,
            autoPause: WorkflowAutoPauseRuntime,
            retention: RetentionRuntime,
            stalledWork: StalledWorkRuntime,
          ) => {
            systemMail?.start();
            workspaceInbox.start();
            autoPause.start();
            retention.start();
            stalledWork.start();
            // Register dependencies before users; the coordinator unwinds them.
            shutdown.register('telemetry', () =>
              dependencies.telemetry.shutdown(),
            );
            if (dependencies.dispatcherDatabaseRuntime !== undefined)
              shutdown.register('dispatcher-database-runtime', () =>
                dependencies.dispatcherDatabaseRuntime?.close(),
              );
            if (dependencies.databaseRuntime !== undefined)
              shutdown.register('database-runtime', () =>
                dependencies.databaseRuntime?.close(),
              );
            shutdown.register('database', () => database.close());
            shutdown.register('transport', () => transport.close());
            if (systemMail !== undefined)
              shutdown.register('authentication-mail', () =>
                systemMail.close(),
              );
            shutdown.register('workspace-inbox', () => workspaceInbox.close());
            shutdown.register('workflow-auto-pause', () => autoPause.close());
            shutdown.register('retention', () => retention.close());
            shutdown.register('stalled-work', () => stalledWork.close());
            return Object.freeze({ registered: true });
          },
        },
      ],
    };
  }
}

function systemMailProvider(
  config: WorkerConfig,
  dependencies: WorkerModuleDependencies,
): Provider {
  return {
    provide: SYSTEM_MAIL_RUNTIME,
    useFactory: (): SystemMailRuntime | undefined => {
      const mail = config.systemMailDelivery;
      if (mail === undefined) return undefined;
      const store = createSystemMailDeliveryStore(
        config.database,
        dependencies.databaseRuntime,
      );
      const envelope = createMailEnvelope(
        mail.encryption,
        'AUTH_MAIL_KEY',
        'AUTH_MAIL_PREVIOUS_KEYS',
      );
      const sender = mail.noticeSender;
      const notices =
        sender === undefined
          ? undefined
          : createNoticeMailStore(
              config.database,
              config.retention.maintenanceDatabase,
              (input) =>
                sealNoticeMail(
                  envelope,
                  sender.fromEmail,
                  sender.publicWebOrigin,
                  input,
                ),
              {
                runtime: dependencies.databaseRuntime,
                onPersonFailed: ({ error, ...fields }) => {
                  dependencies.logger.error(
                    'notice_mail.person_failed',
                    fields,
                    error,
                  );
                },
              },
            );
      const failureAlerts = createFailureNotificationMailAuthorizer(
        config.database,
        config.retention.maintenanceDatabase,
        dependencies.databaseRuntime,
      );
      const handler = createSystemMailDeliveryHandler({
        failureAlerts,
        ...(notices === undefined ? {} : { notices }),
        store,
        envelope,
        email: createSystemMailClient(mail.delivery),
        timeoutMillis: mail.timeoutMillis,
        workerId: mail.workerId,
        onUnavailableKey: (version) => {
          reportUnavailableMailKey(dependencies.logger, version);
        },
        onFailure: (failure) => {
          dependencies.logger.error('system_mail.delivery_failed', {
            ...failure,
          });
        },
      });
      return createSystemMailRuntime(
        handler,
        {
          close: async () => {
            await store.close();
            await notices?.close();
            await failureAlerts.close();
          },
        },
        mail.pollIntervalMillis,
        (error) => {
          dependencies.logger.error(
            'system_mail.delivery_cycle_failed',
            {},
            error,
          );
        },
      );
    },
  };
}

/** Handed the consumers so a stopped one reaches the worker's health check. */
function stalledWorkProvider(
  config: WorkerConfig,
  { logger }: WorkerModuleDependencies,
) {
  return {
    provide: STALLED_WORK_RUNTIME,
    inject: [
      NODE_ATTEMPT_RUNTIME,
      COORDINATOR_RUNTIME,
      TRIGGER_RUNTIME,
      MAINTENANCE_RUNTIME,
    ],
    useFactory: (
      attempts: NodeAttemptRuntime,
      coordinator: CoordinatorRuntime,
      triggers: TriggerRuntime,
      maintenance: MaintenanceRuntime,
    ): StalledWorkRuntime =>
      configuredStalledWorkRuntime(config, logger, {
        attempts: attempts.consumer,
        coordinator: coordinator.consumer,
        triggers: triggers.consumer,
        maintenance: maintenance.consumer,
      }),
  };
}
