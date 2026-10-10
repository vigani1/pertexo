import 'reflect-metadata';

import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { OutboxDispatcherDatabase } from '@pertexo/database/outbox';
import type {
  DatabaseRuntime,
  WorkspaceDatabase,
} from '@pertexo/database/platform';
import { createAuthenticationMailDeliveryStore } from '@pertexo/database/tenant-access';
import { createWorkspaceInboxFoldStore } from '@pertexo/database/notifications';
import {
  createApplicationSecretEnvelope,
  createNodeSecureHttpClient,
  createResendClient,
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
import type { NodeAttemptRuntime } from './attempts/runtime.js';
import type { MaintenanceRuntime } from './maintenance/runtime.js';
import type { TriggerRuntime } from './triggers/runtime.js';
import { createAuthenticationMailDeliveryHandler } from './identity/authentication-mail-delivery.js';
import {
  AUTHENTICATION_MAIL_RUNTIME,
  createAuthenticationMailRuntime,
  type AuthenticationMailRuntime,
} from './identity/authentication-mail-runtime.js';
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
        {
          provide: AUTHENTICATION_MAIL_RUNTIME,
          useFactory: (): AuthenticationMailRuntime | undefined => {
            const mail = config.authenticationMailDelivery;
            if (mail === undefined) return undefined;
            const store = createAuthenticationMailDeliveryStore(
              config.database,
              dependencies.databaseRuntime,
            );
            const handler = createAuthenticationMailDeliveryHandler({
              store,
              envelope: createApplicationSecretEnvelope(mail.encryption),
              email: createResendClient(createNodeSecureHttpClient()),
              apiKey: mail.apiKey,
              timeoutMillis: mail.timeoutMillis,
              workerId: mail.workerId,
            });
            return createAuthenticationMailRuntime(
              handler,
              store,
              mail.pollIntervalMillis,
              () => {
                dependencies.logger.error(
                  'authentication_mail.delivery_cycle_failed',
                );
              },
            );
          },
        },
        {
          provide: WORKSPACE_INBOX_RUNTIME,
          useFactory: (): WorkspaceInboxRuntime =>
            dependencies.workspaceInboxRuntime ??
            createWorkspaceInboxRuntime(
              createWorkspaceInboxFoldStore(
                config.database,
                dependencies.databaseRuntime,
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
            new WorkerReadinessMonitor(
              readiness,
              dependencies.logger,
              dependencies.readinessMarker,
              undefined,
              config.outboxDispatcher.operationTimeoutMillis,
            ),
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
            AUTHENTICATION_MAIL_RUNTIME,
            WORKSPACE_INBOX_RUNTIME,
            WORKFLOW_AUTO_PAUSE_RUNTIME,
            RETENTION_RUNTIME,
          ],
          useFactory: (
            shutdown: WorkerShutdownCoordinator,
            transport: OutboxDispatcherLifecycle,
            database: WorkspaceDatabase,
            authenticationMail: AuthenticationMailRuntime | undefined,
            workspaceInbox: WorkspaceInboxRuntime,
            autoPause: WorkflowAutoPauseRuntime,
            retention: RetentionRuntime,
          ) => {
            authenticationMail?.start();
            workspaceInbox.start();
            autoPause.start();
            retention.start();
            shutdown.register('retention', () => retention.close());
            shutdown.register('workspace-inbox', () => workspaceInbox.close());
            shutdown.register('workflow-auto-pause', () => autoPause.close());
            if (authenticationMail !== undefined)
              shutdown.register('authentication-mail', () =>
                authenticationMail.close(),
              );
            shutdown.register('transport', () => transport.close());
            shutdown.register('database', () => database.close());
            if (dependencies.databaseRuntime !== undefined)
              shutdown.register('database-runtime', () =>
                dependencies.databaseRuntime?.close(),
              );
            if (dependencies.dispatcherDatabaseRuntime !== undefined)
              shutdown.register('dispatcher-database-runtime', () =>
                dependencies.dispatcherDatabaseRuntime?.close(),
              );
            shutdown.register('telemetry', () =>
              dependencies.telemetry.shutdown(),
            );
            return Object.freeze({ registered: true });
          },
        },
      ],
    };
  }
}
