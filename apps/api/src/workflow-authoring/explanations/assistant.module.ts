import { Module, type DynamicModule } from '@nestjs/common';
import type { WorkspaceAuthorizationSource } from '../../authorization/index.js';
import { WORKSPACE_AUTHORIZATION } from '../../workspaces/tokens.js';
import { ExplanationController } from './explanation.controller.js';
import { ExplanationService } from './explanation.service.js';

@Module({})
// oxlint-disable-next-line typescript/no-extraneous-class
export class AssistantModule {
  static register(
    service: ExplanationService,
    authorization: WorkspaceAuthorizationSource,
    identity: DynamicModule,
  ): DynamicModule {
    return {
      module: AssistantModule,
      imports: [identity],
      controllers: [ExplanationController],
      providers: [
        { provide: ExplanationService, useValue: service },
        { provide: WORKSPACE_AUTHORIZATION, useValue: authorization },
      ],
    };
  }
}
