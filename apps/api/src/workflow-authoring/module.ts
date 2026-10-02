import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import {
  CreateWorkflowUseCase,
  GetWorkflowUseCase,
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
  WorkflowPauseDefaultGuard,
  WorkspaceAutoPauseReadGuard,
} from './guards.js';
import { WorkflowAuthoringController } from './controllers.js';
import { WorkflowOrganizationController } from './organization-controller.js';
import { workflowOrganizationProviders } from './organization-providers.js';
import { TransitionWorkflowLifecycleUseCase } from './lifecycle-use-case.js';
import { RenameWorkflowUseCase } from './rename-use-case.js';
import { DuplicateWorkflowUseCase } from './duplicate-use-case.js';
import { WorkflowPortabilityController } from './portability-controller.js';
import {
  ExportWorkflowUseCase,
  ImportWorkflowUseCase,
  PreviewWorkflowImportUseCase,
} from './portability-use-cases.js';
import { RestoreWorkflowVersionUseCase } from './restore-version-use-case.js';
import type { WorkflowAuthoringDependencies } from './ports.js';
import { NOOP_WORKFLOW_AUTHORING_TELEMETRY } from './telemetry.js';
import { WORKFLOW_AUTHORING_AUTHORIZATION } from './tokens.js';
import { WorkflowAutoPauseUseCase } from './auto-pause-use-case.js';
import { WorkflowConcurrencyUseCase } from './concurrency-use-case.js';
import { WorkflowConcurrencyController } from './concurrency-controller.js';
import { WorkflowInputCasesController } from './input-case-controller.js';
import { WorkflowInputCasesUseCase } from './input-case-use-case.js';
import {
  WorkflowAutoPauseController,
  WorkspaceAutoPauseController,
} from './auto-pause-controllers.js';

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WorkflowAuthoringModule {
  public static register(
    dependencies: WorkflowAuthoringDependencies,
    identityModule: DynamicModule,
  ): DynamicModule {
    const telemetry =
      dependencies.telemetry ?? NOOP_WORKFLOW_AUTHORING_TELEMETRY;
    const portabilityPersistence = dependencies.portabilityPersistence;
    const providers: Provider[] = [
      ...workflowOrganizationProviders(dependencies),
      ...(portabilityPersistence === undefined
        ? []
        : [
            ExportWorkflowUseCase,
            ImportWorkflowUseCase,
            PreviewWorkflowImportUseCase,
          ].map((useCase) => ({
            provide: useCase,
            useValue: new useCase(
              portabilityPersistence,
              dependencies.authorization,
              telemetry,
            ),
          }))),
      ...(dependencies.inputCasePersistence === undefined
        ? []
        : [
            {
              provide: WorkflowInputCasesUseCase,
              useValue: new WorkflowInputCasesUseCase(
                dependencies.inputCasePersistence,
                dependencies.authorization,
              ),
            },
          ]),
      {
        provide: DuplicateWorkflowUseCase,
        useValue: new DuplicateWorkflowUseCase(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      ...(dependencies.concurrencyPersistence === undefined
        ? []
        : [
            {
              provide: WorkflowConcurrencyUseCase,
              useValue: new WorkflowConcurrencyUseCase(
                dependencies.concurrencyPersistence,
                dependencies.authorization,
              ),
            },
          ]),
      ...(dependencies.autoPausePersistence === undefined
        ? []
        : [
            {
              provide: WorkflowAutoPauseUseCase,
              useValue: new WorkflowAutoPauseUseCase(
                dependencies.autoPausePersistence,
                dependencies.authorization,
              ),
            },
            WorkflowPauseDefaultGuard,
            WorkspaceAutoPauseReadGuard,
          ]),
      {
        provide: RestoreWorkflowVersionUseCase,
        useValue: new RestoreWorkflowVersionUseCase(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: TransitionWorkflowLifecycleUseCase,
        useValue: new TransitionWorkflowLifecycleUseCase(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: RenameWorkflowUseCase,
        useValue: new RenameWorkflowUseCase(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: WORKFLOW_AUTHORING_AUTHORIZATION,
        useValue: dependencies.authorization,
      },
      WorkflowReadGuard,
      WorkflowCreateGuard,
      WorkflowUpdateGuard,
      WorkflowPublishGuard,
      {
        provide: ListWorkflowsUseCase,
        useValue: new ListWorkflowsUseCase(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: GetWorkflowUseCase,
        useValue: new GetWorkflowUseCase(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: CreateWorkflowUseCase,
        useValue: new CreateWorkflowUseCase(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: GetWorkflowDraftUseCase,
        useValue: new GetWorkflowDraftUseCase(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: SaveWorkflowDraftUseCase,
        useValue: new SaveWorkflowDraftUseCase(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: ValidateWorkflowDraftUseCase,
        useValue: new ValidateWorkflowDraftUseCase(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: PublishWorkflowUseCase,
        useValue: new PublishWorkflowUseCase(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: ListWorkflowVersionsUseCase,
        useValue: new ListWorkflowVersionsUseCase(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
    ];
    return {
      module: WorkflowAuthoringModule,
      imports: [identityModule],
      controllers: [
        WorkflowAuthoringController,
        WorkflowOrganizationController,
        ...(dependencies.portabilityPersistence === undefined
          ? []
          : [WorkflowPortabilityController]),
        ...(dependencies.inputCasePersistence === undefined
          ? []
          : [WorkflowInputCasesController]),
        ...(dependencies.concurrencyPersistence === undefined
          ? []
          : [WorkflowConcurrencyController]),
        ...(dependencies.autoPausePersistence === undefined
          ? []
          : [WorkflowAutoPauseController, WorkspaceAutoPauseController]),
      ],
      providers,
      exports: [
        DuplicateWorkflowUseCase,
        RestoreWorkflowVersionUseCase,
        TransitionWorkflowLifecycleUseCase,
        RenameWorkflowUseCase,
        ListWorkflowsUseCase,
        CreateWorkflowUseCase,
        GetWorkflowUseCase,
        GetWorkflowDraftUseCase,
        SaveWorkflowDraftUseCase,
        ValidateWorkflowDraftUseCase,
        PublishWorkflowUseCase,
        ListWorkflowVersionsUseCase,
      ],
    };
  }
}
