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
import { NodeTestingController } from './controller.js';
import { NodeTestingUpdateGuard } from './guards.js';
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
        provide: TestWorkflowNodeUseCase,
        useValue: new TestWorkflowNodeUseCase(
          dependencies.persistence,
          dependencies.authorization,
          dependencies.release,
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
      controllers: [NodeTestingController],
      providers,
      exports: [TestWorkflowNodeUseCase, GetPreviewRunUseCase],
    };
  }
}
