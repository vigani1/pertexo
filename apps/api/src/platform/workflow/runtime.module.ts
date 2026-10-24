import { GovernanceModule } from '../../governance/module.js';

import { DataTablesModule } from '../../data-tables/module.js';

import { DEFAULT_CODE_SETTINGS, type CodeSettings } from '@pertexo/node-sdk';
import { WorkspaceVariablesModule } from '../../workspace-variables/module.js';

import { createFormStore } from '@pertexo/database/triggers';
import { initialCheckpointFactory } from '@pertexo/execution';
import { FormsModule } from '../../forms/module.js';
import { createPendingTaskStore } from '@pertexo/database/runs';
import { PendingTasksModule } from '../../pending-tasks/module.js';
import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';

import {
  createWorkspaceDatabase,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';

import { JsonataEvaluator } from '@pertexo/workflow-model/server';
import type { ApiIdentityRuntime } from '../identity/runtime.module.js';
import { createApiWorkflowMetadataRuntime } from './metadata-runtime.js';
import {
  RedisRunEventSource,
  type LiveRunEventSource,
} from '../../workflow-runs/events/index.js';
import { WorkflowAuthoringModule } from '../../workflow-authoring/index.js';
import { NodeTestingModule } from '../../node-testing/index.js';
import { WorkflowRunsModule } from '../../workflow-runs/index.js';
import { createCoreWorkflowCompatibility } from './compatibility.js';
import type {
  ApiWorkflowRuntime,
  ApiWorkflowRuntimeOverrides,
  WorkflowResources,
} from './composition/contract.js';
import {
  acquireAuthoringDatabase,
  acquireRunPersistence,
  configuredRunEventStreamer,
} from './composition/acquire.js';
import { assembleWorkflowRuntime } from './composition/assemble.js';
import { collectWorkflowCloseFailures } from './composition/lifecycle.js';
import { productionTelemetry } from './composition/telemetry.js';
export { createCoreWorkflowAuthoringDatabase } from './compatibility.js';
export {
  type ApiWorkflowRuntime,
  type ApiWorkflowRuntimeOverrides,
} from './composition/contract.js';
export async function createApiWorkflowRuntime(
  databaseConfig: DatabaseConfig,
  identityRuntime: ApiIdentityRuntime,
  {
    redisUrl,
    overrides = {},
    runtime,
    codeSettings = DEFAULT_CODE_SETTINGS,
  }: Readonly<{
    redisUrl: string;
    overrides?: ApiWorkflowRuntimeOverrides | undefined;
    runtime?: DatabaseRuntime | undefined;
    codeSettings?: CodeSettings | undefined;
  }>,
): Promise<ApiWorkflowRuntime> {
  const authoring = overrides.authoring ?? {};
  const persistence = overrides.persistence ?? {};
  const streaming = overrides.streaming ?? {};
  const compatibility = createCoreWorkflowCompatibility();
  const resources: WorkflowResources = {
    database: undefined,
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
    const database = acquireAuthoringDatabase(databaseConfig, resources, {
      authoring,
      compatibility,
      codeSettings,
      runtime,
    });
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
      await createApiWorkflowMetadataRuntime(
        databaseConfig,
        authoring,
        runtime,
      ));
    const runPersistence = acquireRunPersistence(databaseConfig, resources, {
      persistence,
      redisUrl,
      runtime,
    });
    let liveSource: LiveRunEventSource | undefined;
    if (streaming.streamer === undefined) {
      resources.eventDatabase =
        streaming.database ??
        (streaming.databaseFactory ?? createWorkspaceDatabase)(
          databaseConfig,
          runtime === undefined ? {} : { runtime },
        );
      liveSource =
        streaming.liveSource ??
        (
          streaming.liveSourceFactory ??
          ((url) => new RedisRunEventSource({ redisUrl: url }))
        )(redisUrl);
    }
    const eventDatabase = resources.eventDatabase;
    const runStreamer = configuredRunEventStreamer(
      streaming,
      eventDatabase,
      liveSource,
    );
    if (runPersistence === undefined || runStreamer === undefined) {
      throw new Error('Workflow run runtime composition is incomplete');
    }
    const telemetry =
      authoring.telemetry ??
      (authoring.telemetryFactory ?? productionTelemetry)();
    const expressionEvaluator = (resources.expressionEvaluator =
      authoring.expressionEvaluatorFactory?.() ?? new JsonataEvaluator());
    return assembleWorkflowRuntime({
      database,
      metadataRuntime,
      pendingTasks,
      forms,
      runPersistence,
      runStreamer,
      liveSource,
      telemetry,
      expressionEvaluator,
      authoringValidator: resources.authoringValidator,
      runAdapter: resources.runAdapter,
      eventDatabase,
      notifications: resources.notifications,
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
