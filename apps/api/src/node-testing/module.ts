import { WorkflowTestSuitesController } from './suites/controller.js';
import { WorkflowTestSuitesUseCase } from './suites/workflow-test-suites.service.js';
import { WorkflowTestsController } from './workflows/controller.js';
import { WorkflowTestsUseCase } from './workflows/workflow-tests.service.js';
import { StepSamplesController } from './samples/controller.js';
import { StepSamplesUseCase } from './samples/step-samples.service.js';
import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import { NodeTestingController } from './controller.js';
import type { NodeTestingDependencies } from './ports.js';
import { WORKSPACE_AUTHORIZATION } from '../workspaces/tokens.js';
import {
  GetPreviewRunUseCase,
  TestWorkflowNodeUseCase,
} from './node-testing.service.js';

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
        provide: WorkflowTestSuitesUseCase,
        useValue: new WorkflowTestSuitesUseCase(
          dependencies.persistence.workflowTestSuites,
          dependencies.authorization,
        ),
      },
      {
        provide: WorkflowTestsUseCase,
        useValue: new WorkflowTestsUseCase(
          dependencies.persistence.workflowTests,
          dependencies.authorization,
        ),
      },
      {
        provide: StepSamplesUseCase,
        useValue: new StepSamplesUseCase(
          dependencies.persistence.stepSamples,
          dependencies.authorization,
        ),
      },
      {
        provide: TestWorkflowNodeUseCase,
        useValue: new TestWorkflowNodeUseCase(
          dependencies.persistence,
          dependencies.authorization,
          undefined,
          dependencies.expressionEvaluator,
        ),
      },
      {
        provide: GetPreviewRunUseCase,
        useValue: new GetPreviewRunUseCase(
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
      exports: [TestWorkflowNodeUseCase, GetPreviewRunUseCase],
    };
  }
}
