import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import {
  DoubleSubmitCsrfPolicy,
  OpaqueSessionService,
} from '../identity/index.js';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../identity-workspace/guards.js';
import { RequestContextStore } from '../platform/http/index.js';
import {
  createSseVisibilityMetrics,
  SSE_VISIBILITY_METRICS,
  type SseVisibilityMetrics,
} from '../platform/observability/sse-visibility-metrics.js';
import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import { WorkflowRunsController } from './controllers.js';
import {
  WorkflowRunCancelGuard,
  WorkflowRunReplayGuard,
  WorkflowRunReadGuard,
  WorkflowRunStartGuard,
} from './guards.js';
import type {
  WorkflowRunEventStreamer,
  WorkflowRunPersistence,
} from './ports.js';
import { WORKFLOW_RUN_AUTHORIZATION } from './tokens.js';
import {
  CancelWorkflowRunUseCase,
  GetWorkflowRunUseCase,
  ReplayWorkflowRunUseCase,
  StartWorkflowRunUseCase,
  StreamRunEventsUseCase,
} from './use-cases.js';

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
        provide: WORKFLOW_RUN_AUTHORIZATION,
        useValue: dependencies.authorization,
      },
      {
        provide: SSE_VISIBILITY_METRICS,
        useValue:
          dependencies.visibilityMetrics ?? createSseVisibilityMetrics(),
      },
      WorkflowRunReadGuard,
      WorkflowRunStartGuard,
      WorkflowRunReplayGuard,
      WorkflowRunCancelGuard,
      {
        provide: SessionAuthenticationGuard,
        useFactory: (
          sessions: OpaqueSessionService,
          contexts: RequestContextStore,
        ) => new SessionAuthenticationGuard(sessions, contexts),
        inject: [OpaqueSessionService, RequestContextStore],
      },
      {
        provide: CsrfProtectionGuard,
        useFactory: (csrf: DoubleSubmitCsrfPolicy) =>
          new CsrfProtectionGuard(csrf),
        inject: [DoubleSubmitCsrfPolicy],
      },
      {
        provide: StartWorkflowRunUseCase,
        useValue: new StartWorkflowRunUseCase(
          dependencies.persistence,
          dependencies.authorization,
        ),
      },
      {
        provide: ReplayWorkflowRunUseCase,
        useValue: new ReplayWorkflowRunUseCase(
          dependencies.persistence,
          dependencies.authorization,
        ),
      },
      {
        provide: GetWorkflowRunUseCase,
        useValue: new GetWorkflowRunUseCase(
          dependencies.persistence,
          dependencies.authorization,
        ),
      },
      {
        provide: StreamRunEventsUseCase,
        useValue: new StreamRunEventsUseCase(
          dependencies.persistence,
          dependencies.authorization,
          dependencies.streamer,
        ),
      },
      {
        provide: CancelWorkflowRunUseCase,
        useValue: new CancelWorkflowRunUseCase(
          dependencies.persistence,
          dependencies.authorization,
        ),
      },
    ];
    return {
      module: WorkflowRunsModule,
      imports: [identityModule],
      controllers: [WorkflowRunsController],
      providers,
      exports: [
        StartWorkflowRunUseCase,
        ReplayWorkflowRunUseCase,
        GetWorkflowRunUseCase,
        StreamRunEventsUseCase,
        CancelWorkflowRunUseCase,
      ],
    };
  }
}
