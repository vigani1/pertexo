import { WorkflowTestSuitesController } from './suites/workflow-test-suites.controller.js';
import { WorkflowTestSuitesService } from './suites/workflow-test-suites.service.js';
import { WorkflowTestsController } from './workflows/workflow-tests.controller.js';
import { WorkflowTestsService } from './workflows/workflow-tests.service.js';
import { StepSamplesController } from './samples/step-samples.controller.js';
import { StepSamplesService } from './samples/step-samples.service.js';
import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import { NodeTestingController } from './node-testing.controller.js';
import type { NodeTestingDependencies } from './ports.js';
import { WORKSPACE_AUTHORIZATION } from '../workspaces/tokens.js';
import { GetPreviewRunService } from './previews/read.js';
import { TestWorkflowNodeService } from './node-testing.service.js';

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class NodeTestingModule {
  public static register(
    dependencies: NodeTestingDependencies,
    identityModule: DynamicModule,
  ): DynamicModule {
    const providers: Provider[] = [
      {
        provide: WORKSPACE_AUTHORIZATION,
        useValue: dependencies.authorization,
      },
      {
        provide: WorkflowTestSuitesService,
        useValue: new WorkflowTestSuitesService(
          dependencies.persistence.workflowTestSuites,
          dependencies.authorization,
        ),
      },
      {
        provide: WorkflowTestsService,
        useValue: new WorkflowTestsService(
          dependencies.persistence.workflowTests,
          dependencies.authorization,
        ),
      },
      {
        provide: StepSamplesService,
        useValue: new StepSamplesService(
          dependencies.persistence.stepSamples,
          dependencies.authorization,
        ),
      },
      {
        provide: TestWorkflowNodeService,
        useValue: new TestWorkflowNodeService(
          dependencies.persistence,
          dependencies.authorization,
          undefined,
          dependencies.expressionEvaluator,
          dependencies.variables,
        ),
      },
      {
        provide: GetPreviewRunService,
        useValue: new GetPreviewRunService(
          dependencies.persistence,
          dependencies.authorization,
        ),
      },
    ];
    return {
      module: NodeTestingModule,
      imports: [identityModule],
      controllers: [
        NodeTestingController,
        StepSamplesController,
        WorkflowTestsController,
        WorkflowTestSuitesController,
      ],
      providers,
      exports: [TestWorkflowNodeService, GetPreviewRunService],
    };
  }
}
