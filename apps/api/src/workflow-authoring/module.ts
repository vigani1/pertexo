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
  CreateWorkflowUseCase,
  GetWorkflowDraftUseCase,
  ListWorkflowVersionsUseCase,
  ListWorkflowsUseCase,
  PublishWorkflowUseCase,
  SaveWorkflowDraftUseCase,
  ValidateWorkflowDraftUseCase,
} from './use-cases.js';
import {
  WorkflowCreateGuard,
  WorkflowPublishGuard,
  WorkflowReadGuard,
  WorkflowUpdateGuard,
} from './guards.js';
import { WorkflowAuthoringController } from './controllers.js';
import { TransitionWorkflowLifecycleUseCase } from './lifecycle-use-case.js';
import type { WorkflowAuthoringDependencies } from './ports.js';
import { NOOP_WORKFLOW_AUTHORING_TELEMETRY } from './telemetry.js';
import {
  WORKFLOW_AUTHORING_AUTHORIZATION,
  WORKFLOW_AUTHORING_PERSISTENCE,
  WORKFLOW_AUTHORING_TELEMETRY,
  WORKFLOW_DEFINITION_CATALOG,
} from './tokens.js';

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WorkflowAuthoringModule {
  public static register(
    dependencies: WorkflowAuthoringDependencies,
    identityModule: DynamicModule,
  ): DynamicModule {
    const providers: Provider[] = [
      {
        provide: TransitionWorkflowLifecycleUseCase,
        useValue: new TransitionWorkflowLifecycleUseCase(
          dependencies.persistence,
          dependencies.authorization,
          dependencies.telemetry ?? NOOP_WORKFLOW_AUTHORING_TELEMETRY,
        ),
      },
      {
        provide: WORKFLOW_AUTHORING_PERSISTENCE,
        useValue: dependencies.persistence,
      },
      {
        provide: WORKFLOW_AUTHORING_AUTHORIZATION,
        useValue: dependencies.authorization,
      },
      {
        provide: WORKFLOW_AUTHORING_TELEMETRY,
        useValue: dependencies.telemetry ?? NOOP_WORKFLOW_AUTHORING_TELEMETRY,
      },
      WorkflowReadGuard,
      WorkflowCreateGuard,
      WorkflowUpdateGuard,
      WorkflowPublishGuard,
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
      ...(dependencies.definitionCatalog === undefined
        ? []
        : [
            {
              provide: WORKFLOW_DEFINITION_CATALOG,
              useValue: dependencies.definitionCatalog,
            } satisfies Provider,
          ]),
      {
        provide: ListWorkflowsUseCase,
        useValue: new ListWorkflowsUseCase(
          dependencies.persistence,
          dependencies.authorization,
          dependencies.telemetry ?? NOOP_WORKFLOW_AUTHORING_TELEMETRY,
        ),
      },
      {
        provide: CreateWorkflowUseCase,
        useValue: new CreateWorkflowUseCase(
          dependencies.persistence,
          dependencies.authorization,
          dependencies.telemetry ?? NOOP_WORKFLOW_AUTHORING_TELEMETRY,
        ),
      },
      {
        provide: GetWorkflowDraftUseCase,
        useValue: new GetWorkflowDraftUseCase(
          dependencies.persistence,
          dependencies.authorization,
          dependencies.telemetry ?? NOOP_WORKFLOW_AUTHORING_TELEMETRY,
        ),
      },
      {
        provide: SaveWorkflowDraftUseCase,
        useValue: new SaveWorkflowDraftUseCase(
          dependencies.persistence,
          dependencies.authorization,
          dependencies.telemetry ?? NOOP_WORKFLOW_AUTHORING_TELEMETRY,
        ),
      },
      {
        provide: ValidateWorkflowDraftUseCase,
        useValue: new ValidateWorkflowDraftUseCase(
          dependencies.persistence,
          dependencies.authorization,
          dependencies.telemetry ?? NOOP_WORKFLOW_AUTHORING_TELEMETRY,
        ),
      },
      {
        provide: PublishWorkflowUseCase,
        useValue: new PublishWorkflowUseCase(
          dependencies.persistence,
          dependencies.authorization,
          dependencies.telemetry ?? NOOP_WORKFLOW_AUTHORING_TELEMETRY,
        ),
      },
      {
        provide: ListWorkflowVersionsUseCase,
        useValue: new ListWorkflowVersionsUseCase(
          dependencies.persistence,
          dependencies.authorization,
          dependencies.telemetry ?? NOOP_WORKFLOW_AUTHORING_TELEMETRY,
        ),
      },
    ];
    return {
      module: WorkflowAuthoringModule,
      imports: [identityModule],
      controllers: [WorkflowAuthoringController],
      providers,
      exports: [
        TransitionWorkflowLifecycleUseCase,
        ListWorkflowsUseCase,
        CreateWorkflowUseCase,
        GetWorkflowDraftUseCase,
        SaveWorkflowDraftUseCase,
        ValidateWorkflowDraftUseCase,
        PublishWorkflowUseCase,
        ListWorkflowVersionsUseCase,
      ],
    };
  }
}
