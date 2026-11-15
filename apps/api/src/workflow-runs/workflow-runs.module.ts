import { GetUsageTrendsService } from './usage/trends.js';
import { UsageTrendsController } from './usage/usage-trends.controller.js';
import {
  GetRunRecoveryService,
  RecoverRunService,
} from './recovery/run-recovery.service.js';
import { RunRecoveryController } from './recovery/run-recovery.controller.js';
import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import {
  createSseVisibilityMetrics,
  SSE_VISIBILITY_METRICS,
  type SseVisibilityMetrics,
} from '../platform/observability/sse-visibility-metrics.js';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { ApiLifecycleModule } from '../platform/health/drain-state.js';
import { WorkflowRunsController } from './http/workflow-runs.controller.js';
import type {
  WorkflowRunEventStreamer,
  WorkflowRunPersistence,
} from './ports.js';
import { WorkflowRunDataController } from './run-data/workflow-run-data.controller.js';
import {
  GetWorkflowNodeRunInputService,
  GetWorkflowNodeRunDiagnosticsService,
  GetWorkflowNodeRunOutputService,
  GetWorkflowRunInputService,
  GetWorkflowRunVariablesService,
  GetWorkflowStepHealthService,
  ListWorkflowStepRunsService,
} from './run-data/run-data.service.js';
import { GetWorkflowRunStatisticsService } from './statistics.js';
import { GetUsageCapacityService } from './usage/capacity.js';
import { UsageCapacityController } from './usage/usage-capacity.controller.js';
import { WORKSPACE_AUTHORIZATION } from '../workspaces/tokens.js';
import {
  CancelWorkflowRunService,
  GetWorkflowRunService,
  ListWorkflowRunsService,
  ReplayWorkflowRunService,
  StartWorkflowRunService,
  StreamRunEventsService,
} from './workflow-runs.service.js';

export type WorkflowRunsDependencies = Readonly<{
  persistence: WorkflowRunPersistence;
  authorization: WorkspaceAuthorizationSource;
  streamer: WorkflowRunEventStreamer;
  visibilityMetrics?: SseVisibilityMetrics;
}>;

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WorkflowRunsModule {
  public static register(
    dependencies: WorkflowRunsDependencies,
    identityModule: DynamicModule,
  ): DynamicModule {
    const providers: Provider[] = [
      {
        provide: WORKSPACE_AUTHORIZATION,
        useValue: dependencies.authorization,
      },
      {
        provide: SSE_VISIBILITY_METRICS,
        useValue:
          dependencies.visibilityMetrics ?? createSseVisibilityMetrics(),
      },
      {
        provide: GetUsageTrendsService,
        useValue: new GetUsageTrendsService(
          dependencies.persistence,
          dependencies.authorization,
        ),
      },
      {
        provide: GetUsageCapacityService,
        useValue: new GetUsageCapacityService(
          dependencies.persistence,
          dependencies.authorization,
        ),
      },
      {
        provide: GetRunRecoveryService,
        useValue: new GetRunRecoveryService(
          dependencies.persistence,
          dependencies.authorization,
        ),
      },
      {
        provide: RecoverRunService,
        useValue: new RecoverRunService(
          dependencies.persistence,
          dependencies.authorization,
        ),
      },
      {
        provide: StartWorkflowRunService,
        useValue: new StartWorkflowRunService(
          dependencies.persistence,
          dependencies.authorization,
        ),
      },
      {
        provide: ReplayWorkflowRunService,
        useValue: new ReplayWorkflowRunService(
          dependencies.persistence,
          dependencies.authorization,
        ),
      },
      {
        provide: GetWorkflowRunService,
        useValue: new GetWorkflowRunService(
          dependencies.persistence,
          dependencies.authorization,
        ),
      },
      {
        provide: ListWorkflowRunsService,
        useValue: new ListWorkflowRunsService(
          dependencies.persistence,
          dependencies.authorization,
        ),
      },
      ...runDataProviders(dependencies),
      {
        provide: GetWorkflowRunStatisticsService,
        useValue: new GetWorkflowRunStatisticsService(
          dependencies.persistence,
          dependencies.authorization,
        ),
      },
      {
        provide: StreamRunEventsService,
        useValue: new StreamRunEventsService(
          dependencies.persistence,
          dependencies.authorization,
          dependencies.streamer,
        ),
      },
      {
        provide: CancelWorkflowRunService,
        useValue: new CancelWorkflowRunService(
          dependencies.persistence,
          dependencies.authorization,
        ),
      },
    ];
    return {
      module: WorkflowRunsModule,
      imports: [ApiLifecycleModule, identityModule],
      controllers: [
        WorkflowRunsController,
        RunRecoveryController,
        WorkflowRunDataController,
        UsageCapacityController,
        UsageTrendsController,
      ],
      providers,
      exports: [
        StartWorkflowRunService,
        ReplayWorkflowRunService,
        GetWorkflowRunService,
        ListWorkflowRunsService,
        GetWorkflowRunStatisticsService,
        GetUsageCapacityService,
        GetUsageTrendsService,
        GetWorkflowRunInputService,
        GetWorkflowRunVariablesService,
        GetWorkflowNodeRunOutputService,
        GetWorkflowNodeRunInputService,
        GetWorkflowNodeRunDiagnosticsService,
        GetWorkflowStepHealthService,
        ListWorkflowStepRunsService,
        StreamRunEventsService,
        CancelWorkflowRunService,
      ],
    };
  }
}

function runDataProviders(dependencies: WorkflowRunsDependencies): Provider[] {
  return [
    {
      provide: GetWorkflowRunVariablesService,
      useValue: new GetWorkflowRunVariablesService(
        dependencies.persistence,
        dependencies.authorization,
      ),
    },
    {
      provide: GetWorkflowRunInputService,
      useValue: new GetWorkflowRunInputService(
        dependencies.persistence,
        dependencies.authorization,
      ),
    },
    {
      provide: GetWorkflowNodeRunOutputService,
      useValue: new GetWorkflowNodeRunOutputService(
        dependencies.persistence,
        dependencies.authorization,
      ),
    },
    {
      provide: GetWorkflowNodeRunDiagnosticsService,
      useValue: new GetWorkflowNodeRunDiagnosticsService(
        dependencies.persistence,
        dependencies.authorization,
      ),
    },
    {
      provide: GetWorkflowNodeRunInputService,
      useValue: new GetWorkflowNodeRunInputService(
        dependencies.persistence,
        dependencies.authorization,
      ),
    },
    {
      provide: GetWorkflowStepHealthService,
      useValue: new GetWorkflowStepHealthService(
        dependencies.persistence,
        dependencies.authorization,
      ),
    },
    {
      provide: ListWorkflowStepRunsService,
      useValue: new ListWorkflowStepRunsService(
        dependencies.persistence,
        dependencies.authorization,
      ),
    },
  ];
}
