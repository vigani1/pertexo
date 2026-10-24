import { sealNoticeMail } from './mail/notice-content.js';
import 'reflect-metadata';

import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { OutboxDispatcherDatabase } from '@pertexo/database/outbox';
import type {
  DatabaseRuntime,
  WorkspaceDatabase,
} from '@pertexo/database/platform';
import { createSystemMailDeliveryStore } from '@pertexo/database/platform';
import {
  createNoticeMailStore,
  createWorkspaceInboxFoldStore,
} from '@pertexo/database/notifications';
import {
  createApplicationSecretEnvelope,
  createSystemMailClient,
} from '@pertexo/integrations/server';
import {
  RedisWorkspaceInboxHintPublisher,
  type QueueProducer,
} from '@pertexo/queue';
import type {
  StructuredLogger,
  TelemetryLifecycle,
  TransportMetrics,
} from '@pertexo/observability';

import type { WorkerConfig } from './config/worker.js';
import type { CoordinatorRuntime } from './runs/runtime.js';
import type { NodeAttemptRuntime } from './attempts/delivery/runtime.js';
import type { MaintenanceRuntime } from './maintenance/runtime.js';
import type { TriggerRuntime } from './triggers/runtime.js';
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
import { WorkerReadiness } from './runtime/health/readiness.js';
import {
  WorkerReadinessMonitor,
  type WorkerReadinessMarker,
} from './runtime/health/readiness-monitor.js';
import { WorkerResourceMonitor } from './runtime/health/resource-monitor.js';
import { WorkerDrainState } from './runtime/shutdown/drain-state.js';
import { WorkerProcessKeepalive } from './runtime/process-keepalive.js';
import { WorkerShutdownCoordinator } from './runtime/shutdown/coordinator.js';
import { TransportModule } from './transport/module.js';
import { OutboxDispatcherLifecycle } from './transport/lifecycle.js';

export type WorkerModuleDependencies = Readonly<{
  coordinatorRuntime?: CoordinatorRuntime;
  nodeAttemptRuntime?: NodeAttemptRuntime;
  maintenanceRuntime?: MaintenanceRuntime;
  triggerRuntime?: TriggerRuntime;
  database?: WorkspaceDatabase;
  databaseRuntime?: DatabaseRuntime;
  dispatcherDatabase?: OutboxDispatcherDatabase;
  dispatcherDatabaseRuntime?: DatabaseRuntime;
  queueProducer?: QueueProducer;
  workspaceInboxRuntime?: WorkspaceInboxRuntime;
  workflowAutoPauseRuntime?: WorkflowAutoPauseRuntime;
  retentionRuntime?: RetentionRuntime;
  logger: StructuredLogger;
  telemetry: TelemetryLifecycle;
  transportMetrics?: TransportMetrics;
  readinessMarker?: WorkerReadinessMarker;
}>;

@Module({})
// Nest requires a class as the root module passed to the application factory.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WorkerModule {
  public static register(
    config: WorkerConfig,
    dependencies: WorkerModuleDependencies,
  ): DynamicModule {
    const databaseOptions =
      dependencies.database === undefined
        ? {
            ...(dependencies.databaseRuntime === undefined
              ? {}
              : { runtime: dependencies.databaseRuntime }),
          }
        : {
            database: dependencies.database,
          };

    return {
      module: WorkerModule,
      imports: [
        DatabaseModule.register(config.database, databaseOptions),
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
            dependencies.workspaceInboxRuntime ??
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
            dependencies.retentionRuntime ??
            configuredRetentionRuntime(config, dependencies.logger),
        },
        {
          provide: WorkerReadinessMonitor,
          inject: [WorkerReadiness],
          useFactory: (readiness: WorkerReadiness): WorkerReadinessMonitor =>
            new WorkerReadinessMonitor(readiness, dependencies.logger, {
              marker: dependencies.readinessMarker,
              failClosed: undefined,
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
          ) => {
            systemMail?.start();
            workspaceInbox.start();
            autoPause.start();
            retention.start();
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
              dependencies.databaseRuntime,
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
