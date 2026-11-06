import { buildWorkflowTestExecutable } from '@pertexo/workflow-engine/server';
import { createNodeTestingRuntime } from './composition/node-testing.runtime.js';
import { GovernanceModule } from '../../governance/governance.module.js';

import { DataTablesModule } from '../../data-tables/data-tables.module.js';

import { DEFAULT_CODE_SETTINGS, type CodeSettings } from '@pertexo/node-sdk';
import { WorkspaceVariablesModule } from '../../workspace-variables/workspace-variables.module.js';

import { createFormStore } from '@pertexo/core/triggers';
import { initialCheckpointFactory } from '@pertexo/core/runs';
import { FormsModule } from '../../forms/forms.module.js';
import { createPendingTaskStore } from '@pertexo/core/runs';
import { PendingTasksModule } from '../../pending-tasks/pending-tasks.module.js';
import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';

import {
  createWorkspaceDatabase,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';

import { createWorkflowAuthoringStore } from '@pertexo/core/authoring';
import {
  JsonataEvaluator,
  WorkflowAuthoringValidator,
} from '@pertexo/workflow-model/server';
import type { ApiIdentityRuntime } from '../identity/runtime.module.js';
import { createApiWorkflowMetadataRuntime } from './metadata-runtime.js';
import { createPostgresRunEventReader } from '../../workflow-runs/events/postgres-reader.js';
import { RedisRunEventNotificationPublisher as RedisRunEventPublisher } from '@pertexo/queue/server';
import { RedisRunEventSource } from '../../workflow-runs/events/redis-source.js';
import { WorkflowAuthoringModule } from '../../workflow-authoring/index.js';
import { NodeTestingModule } from '../../node-testing/index.js';
import { createPostgresWorkflowRunPersistence } from '../../workflow-runs/postgres-persistence.js';
import { createWorkflowRunEventStreamer } from '../../workflow-runs/events/streamer.js';
import { WorkflowRunsModule } from '../../workflow-runs/workflow-runs.module.js';
import {
  createCoreAuthoringOptions,
  createCoreWorkflowCompatibility,
} from './compatibility.js';
import type {
  ApiWorkflowRuntime,
  WorkflowResources,
} from './composition/workflow-runtime.types.js';
import { assembleWorkflowRuntime } from './composition/assemble.js';
import { collectWorkflowCloseFailures } from './composition/lifecycle.js';
import { productionTelemetry } from './composition/telemetry.js';
export { createCoreWorkflowAuthoringDatabase } from './compatibility.js';
export { type ApiWorkflowRuntime } from './composition/workflow-runtime.types.js';
export async function createApiWorkflowRuntime(
  databaseConfig: DatabaseConfig,
  identityRuntime: ApiIdentityRuntime,
  {
    redisUrl,
    runtime,
    codeSettings = DEFAULT_CODE_SETTINGS,
  }: Readonly<{
    redisUrl: string;
    runtime?: DatabaseRuntime | undefined;
    codeSettings?: CodeSettings | undefined;
  }>,
): Promise<ApiWorkflowRuntime> {
  const compatibility = createCoreWorkflowCompatibility();
  const resources: WorkflowResources = {
    database: undefined,
    nodeTesting: undefined,
    metadataRuntime: undefined,
    pendingTasks: undefined,
    forms: undefined,
    notifications: undefined,
    runAdapter: undefined,
    eventDatabase: undefined,
    expressionEvaluator: undefined,
    authoringValidator: undefined,
  };
  try {
    const authoringValidator = (resources.authoringValidator =
      new WorkflowAuthoringValidator());
    const database = (resources.database = createWorkflowAuthoringStore(
      databaseConfig,
      {
        ...createCoreAuthoringOptions(
          compatibility,
          authoringValidator,
          codeSettings,
        ),
        ...(runtime === undefined ? {} : { runtime }),
      },
    ));
    const nodeTesting = (resources.nodeTesting = createNodeTestingRuntime(
      databaseConfig,
      database,
      (graph, pins) =>
        buildWorkflowTestExecutable({
          graph,
          pins,
          catalog: compatibility.catalog,
        }),
      runtime,
    ));
    const pendingTasks = (resources.pendingTasks = createPendingTaskStore(
      databaseConfig,
      runtime,
    ));
    const forms = (resources.forms = createFormStore(
      databaseConfig,
      initialCheckpointFactory({ catalog: compatibility.catalog }),
      runtime,
    ));
    const metadataRuntime = (resources.metadataRuntime =
      await createApiWorkflowMetadataRuntime(databaseConfig, runtime));
    const notifications = (resources.notifications = new RedisRunEventPublisher(
      { redisUrl },
    ));
    const runAdapter = (resources.runAdapter =
      createPostgresWorkflowRunPersistence(
        databaseConfig,
        undefined,
        notifications,
        runtime,
      ));
    const eventDatabase = (resources.eventDatabase = createWorkspaceDatabase(
      databaseConfig,
      runtime === undefined ? {} : { runtime },
    ));
    const liveSource = new RedisRunEventSource({ redisUrl });
    const runStreamer = createWorkflowRunEventStreamer(
      createPostgresRunEventReader(eventDatabase),
      liveSource,
    );
    const telemetry = productionTelemetry();
    const expressionEvaluator = (resources.expressionEvaluator =
      new JsonataEvaluator());
    return assembleWorkflowRuntime({
      database,
      nodeTesting,
      metadataRuntime,
      pendingTasks,
      forms,
      runPersistence: runAdapter.persistence,
      runStreamer,
      liveSource,
      telemetry,
      expressionEvaluator,
      authoringValidator,
      runAdapter,
      eventDatabase,
      notifications,
      identityRuntime,
    });
  } catch (error: unknown) {
    const cleanupFailures = await collectWorkflowCloseFailures(
      resources.database,
      resources.runAdapter,
      {
        events: resources.eventDatabase,
        notifications: resources.notifications,
        expressionEvaluator: resources.expressionEvaluator,
        authoringValidator: resources.authoringValidator,
        metadata: resources.metadataRuntime,
        pendingTasks: resources.pendingTasks,
        forms: resources.forms,
        nodeTesting: resources.nodeTesting,
      },
    );
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Workflow runtime construction and cleanup failed',
      );
    throw error;
  }
}

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WorkflowRuntimeModule {
  public static register(
    runtime: ApiWorkflowRuntime,
    identityModule: DynamicModule,
    admission: DynamicModule,
  ): DynamicModule {
    return {
      module: WorkflowRuntimeModule,
      imports: [
        WorkflowAuthoringModule.register(runtime.dependencies, identityModule),
        ...(runtime.nodeTestingDependencies === undefined
          ? []
          : [
              NodeTestingModule.register(
                runtime.nodeTestingDependencies,
                identityModule,
              ),
            ]),
        WorkflowRunsModule.register(runtime.runDependencies, identityModule),
        ...(runtime.governance === undefined
          ? []
          : [
              GovernanceModule.register(
                runtime.governance,
                runtime.dependencies.authorization,
                identityModule,
                admission,
              ),
            ]),
        ...(runtime.dataTables === undefined
          ? []
          : [
              DataTablesModule.register(
                runtime.dataTables,
                runtime.dependencies.authorization,
                identityModule,
                admission,
              ),
            ]),
        ...(runtime.variables === undefined
          ? []
          : [
              WorkspaceVariablesModule.register(
                runtime.variables,
                runtime.dependencies.authorization,
                identityModule,
              ),
            ]),
        ...(runtime.forms === undefined
          ? []
          : [
              FormsModule.register(
                runtime.forms,
                runtime.dependencies.authorization,
                identityModule,
                admission,
              ),
            ]),
        ...(runtime.pendingTasks === undefined
          ? []
          : [
              PendingTasksModule.register(
                runtime.pendingTasks,
                runtime.dependencies.authorization,
                identityModule,
              ),
            ]),
      ],
      providers: [],
    };
  }
}
