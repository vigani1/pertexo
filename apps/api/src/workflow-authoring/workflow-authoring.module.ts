import type { DynamicModule, Provider } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { WorkflowCommentsController } from './collaboration/comments.controller.js';
import { WorkflowPresenceController } from './collaboration/presence.controller.js';
import { WorkflowCollaborationService } from './collaboration/workflow-collaboration.service.js';
import { WorkflowLifecycleController } from './http/lifecycle.controller.js';
import { WorkflowVersionsController } from './http/versions.controller.js';
import { WorkflowPromotionController } from './promotion/workflow-promotion.controller.js';
import { workflowPromotionProviders } from './promotion/providers.js';
import {
  PublicationReviewController,
  WorkflowPublicationReviewController,
} from './reviews/publication-review.controller.js';
import { PublicationReviewService } from './reviews/publication-review.service.js';
import { WorkflowErrorController } from './settings/error-workflow.controller.js';
import { WorkflowErrorService } from './settings/error-workflow.js';

import {
  CreateWorkflowService,
  GetWorkflowDraftService,
  GetWorkflowService,
  ListWorkflowVersionsService,
  ListWorkflowsService,
  PublishWorkflowService,
  SaveWorkflowDraftService,
  ValidateWorkflowDraftService,
} from './workflow-authoring.service.js';

import { WORKSPACE_AUTHORIZATION } from '../workspaces/tokens.js';
import { DuplicateWorkflowService } from './commands/duplicate.js';
import { TransitionWorkflowLifecycleService } from './commands/lifecycle.js';
import { RenameWorkflowService } from './commands/rename.js';
import { RestoreWorkflowVersionService } from './commands/restore-version.js';
import { WorkflowAuthoringController } from './http/workflow-authoring.controller.js';
import { WorkflowInputCasesController } from './input-cases/workflow-input-cases.controller.js';
import { WorkflowInputCasesService } from './input-cases/workflow-input-cases.service.js';
import {
  workflowOrganizationControllers,
  workflowOrganizationProviders,
} from './organization/providers.js';
import { WorkflowPortabilityController } from './portability/workflow-portability.controller.js';
import {
  ExportWorkflowService,
  ImportWorkflowService,
  PreviewWorkflowImportService,
} from './portability/workflow-portability.service.js';
import type { WorkflowAuthoringDependencies } from './ports.js';
import {
  WorkflowAutoPauseController,
  WorkspaceAutoPauseController,
} from './settings/auto-pause-controllers.js';
import { WorkflowAutoPauseService } from './settings/auto-pause.js';
import { WorkflowConcurrencyController } from './settings/concurrency.controller.js';
import { WorkflowConcurrencyService } from './settings/concurrency.js';
import {
  NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  type WorkflowAuthoringTelemetry,
} from './telemetry.js';

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
      ...workflowFeatureProviders(
        dependencies,
        telemetry,
        portabilityPersistence,
      ),
      ...workflowLifecycleProviders(dependencies, telemetry),

      // Declared routes build their guards on this token.
      {
        provide: WORKSPACE_AUTHORIZATION,
        useValue: dependencies.authorization,
      },

      {
        provide: ListWorkflowsService,
        useValue: new ListWorkflowsService(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: GetWorkflowService,
        useValue: new GetWorkflowService(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: CreateWorkflowService,
        useValue: new CreateWorkflowService(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: GetWorkflowDraftService,
        useValue: new GetWorkflowDraftService(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: SaveWorkflowDraftService,
        useValue: new SaveWorkflowDraftService(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: ValidateWorkflowDraftService,
        useValue: new ValidateWorkflowDraftService(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: PublishWorkflowService,
        useValue: new PublishWorkflowService(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: ListWorkflowVersionsService,
        useValue: new ListWorkflowVersionsService(
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
        WorkflowLifecycleController,
        WorkflowVersionsController,
        ...(dependencies.collaborationPersistence === undefined
          ? []
          : [WorkflowCommentsController, WorkflowPresenceController]),
        ...(dependencies.promotionPersistence === undefined
          ? []
          : [WorkflowPromotionController]),
        ...(dependencies.publicationReviewPersistence === undefined
          ? []
          : [WorkflowPublicationReviewController, PublicationReviewController]),
        ...workflowOrganizationControllers,
        ...(dependencies.portabilityPersistence === undefined
          ? []
          : [WorkflowPortabilityController]),
        ...(dependencies.inputCasePersistence === undefined
          ? []
          : [WorkflowInputCasesController]),
        ...(dependencies.errorWorkflowPersistence === undefined
          ? []
          : [WorkflowErrorController]),
        ...(dependencies.concurrencyPersistence === undefined
          ? []
          : [WorkflowConcurrencyController]),
        ...(dependencies.autoPausePersistence === undefined
          ? []
          : [WorkflowAutoPauseController, WorkspaceAutoPauseController]),
      ],
      providers,
      exports: [
        DuplicateWorkflowService,
        RestoreWorkflowVersionService,
        TransitionWorkflowLifecycleService,
        RenameWorkflowService,
        ListWorkflowsService,
        CreateWorkflowService,
        GetWorkflowService,
        GetWorkflowDraftService,
        SaveWorkflowDraftService,
        ValidateWorkflowDraftService,
        PublishWorkflowService,
        ListWorkflowVersionsService,
      ],
    };
  }
}

function workflowFeatureProviders(
  dependencies: WorkflowAuthoringDependencies,
  telemetry: WorkflowAuthoringTelemetry,
  portabilityPersistence: WorkflowAuthoringDependencies['portabilityPersistence'],
): Provider[] {
  return [
    ...workflowOrganizationProviders(dependencies),
    ...workflowPromotionProviders(dependencies),
    ...(dependencies.collaborationPersistence === undefined
      ? []
      : [
          {
            provide: WorkflowCollaborationService,
            useValue: new WorkflowCollaborationService(
              dependencies.collaborationPersistence,
              dependencies.authorization,
            ),
          },
        ]),
    ...(dependencies.publicationReviewPersistence === undefined
      ? []
      : [
          {
            provide: PublicationReviewService,
            useValue: new PublicationReviewService(
              dependencies.publicationReviewPersistence,
              dependencies.authorization,
            ),
          },
        ]),
    ...(portabilityPersistence === undefined
      ? []
      : [
          ExportWorkflowService,
          ImportWorkflowService,
          PreviewWorkflowImportService,
        ].map((service) => ({
          provide: service,
          useValue: new service(
            portabilityPersistence,
            dependencies.authorization,
            telemetry,
          ),
        }))),
    ...(dependencies.inputCasePersistence === undefined
      ? []
      : [
          {
            provide: WorkflowInputCasesService,
            useValue: new WorkflowInputCasesService(
              dependencies.inputCasePersistence,
              dependencies.authorization,
            ),
          },
        ]),
    {
      provide: DuplicateWorkflowService,
      useValue: new DuplicateWorkflowService(
        dependencies.persistence,
        dependencies.authorization,
        telemetry,
      ),
    },
    ...(dependencies.errorWorkflowPersistence === undefined
      ? []
      : [
          {
            provide: WorkflowErrorService,
            useValue: new WorkflowErrorService(
              dependencies.errorWorkflowPersistence,
              dependencies.authorization,
            ),
          },
        ]),
    ...(dependencies.concurrencyPersistence === undefined
      ? []
      : [
          {
            provide: WorkflowConcurrencyService,
            useValue: new WorkflowConcurrencyService(
              dependencies.concurrencyPersistence,
              dependencies.authorization,
            ),
          },
        ]),
    ...(dependencies.autoPausePersistence === undefined
      ? []
      : [
          {
            provide: WorkflowAutoPauseService,
            useValue: new WorkflowAutoPauseService(
              dependencies.autoPausePersistence,
              dependencies.authorization,
            ),
          },
        ]),
  ];
}

function workflowLifecycleProviders(
  dependencies: WorkflowAuthoringDependencies,
  telemetry: WorkflowAuthoringTelemetry,
): Provider[] {
  return [
    {
      provide: RestoreWorkflowVersionService,
      useValue: new RestoreWorkflowVersionService(
        dependencies.persistence,
        dependencies.authorization,
        telemetry,
      ),
    },
    {
      provide: TransitionWorkflowLifecycleService,
      useValue: new TransitionWorkflowLifecycleService(
        dependencies.persistence,
        dependencies.authorization,
        telemetry,
      ),
    },
    {
      provide: RenameWorkflowService,
      useValue: new RenameWorkflowService(
        dependencies.persistence,
        dependencies.authorization,
        telemetry,
      ),
    },
  ];
}
