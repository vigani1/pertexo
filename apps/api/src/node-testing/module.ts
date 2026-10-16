import { StepSamplesController } from './samples/controller.js';
import { StepSamplesUseCase } from './samples/use-case.js';
import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import { NodeTestingController } from './controller.js';
import { NodeTestingUpdateGuard, NodeSamplesReadGuard } from './guards.js';
import type { NodeTestingDependencies } from './ports.js';
import { NODE_TESTING_AUTHORIZATION } from './tokens.js';
import { GetPreviewRunUseCase, TestWorkflowNodeUseCase } from './use-case.js';

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
        provide: NODE_TESTING_AUTHORIZATION,
        useValue: dependencies.authorization,
      },
      NodeTestingUpdateGuard,
      NodeSamplesReadGuard,
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
      controllers: [NodeTestingController, StepSamplesController],
      providers,
      exports: [TestWorkflowNodeUseCase, GetPreviewRunUseCase],
    };
  }
}
