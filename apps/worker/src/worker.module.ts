import { sealNoticeMail } from './mail/notice-content.js';
import 'reflect-metadata';

import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type {
  DatabaseRuntime,
  WorkspaceDatabase,
} from '@pertexo/database/platform';
import { createSystemMailDeliveryStore } from '@pertexo/database/platform';
import {
  createNoticeMailStore,
  createWorkspaceInboxFoldStore,
} from '@pertexo/core/inbox';
import {
  createApplicationSecretEnvelope,
  createSystemMailClient,
} from '@pertexo/integrations/server';
import { RedisWorkspaceInboxHintPublisher } from '@pertexo/queue';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';

import type { WorkerConfig } from './config/worker.js';
import { createSystemMailDeliveryHandler } from './mail/delivery.js';
import {
  SYSTEM_MAIL_RUNTIME,
  createSystemMailRuntime,
  type SystemMailRuntime,
} from './mail/runtime.js';
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
} from './platform/database/module.js';
import { ObservabilityModule } from './platform/observability/module.js';
import { configuredRetentionRuntime } from './retention/composition.js';
import {
  RETENTION_RUNTIME,
  type RetentionRuntime,
} from './retention/runtime.js';
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
import { TransportModule } from './transport/module.js';
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
                cycleFailed: () => {
                  dependencies.logger.error('workspace_inbox.cycle_failed');
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
        {
          provide: STALLED_WORK_RUNTIME,
          useFactory: (): StalledWorkRuntime =>
            configuredStalledWorkRuntime(config, dependencies.logger),
        },
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
      const envelope = createApplicationSecretEnvelope(mail.encryption);
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
      const handler = createSystemMailDeliveryHandler({
        ...(notices === undefined ? {} : { notices }),
        store,
        envelope,
        email: createSystemMailClient(mail.delivery),
        timeoutMillis: mail.timeoutMillis,
        workerId: mail.workerId,
      });
      return createSystemMailRuntime(
        handler,
        {
          close: async () => {
            await store.close();
            await notices?.close();
          },
        },
        mail.pollIntervalMillis,
        () => {
          dependencies.logger.error('system_mail.delivery_cycle_failed');
        },
      );
    },
  };
}
