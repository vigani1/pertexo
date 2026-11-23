import { Module, type DynamicModule } from '@nestjs/common';
import type { WorkspaceAuthorizationSource } from '../authorization/index.js';
import { WORKSPACE_AUTHORIZATION } from '../workspaces/tokens.js';
import { ExplanationController } from './explanations/explanation.controller.js';
import { ExplanationService } from './explanations/explanation.service.js';

import { DraftProposalController } from './proposals/draft-proposal.controller.js';
import { ProposeDraftService } from './proposals/propose-draft.service.js';

@Module({})
// oxlint-disable-next-line typescript/no-extraneous-class
export class AssistantModule {
  static register(
    service: ExplanationService,
    proposals: ProposeDraftService,
    authorization: WorkspaceAuthorizationSource,
    identity: DynamicModule,
  ): DynamicModule {
    return {
      module: AssistantModule,
      imports: [identity],
      controllers: [ExplanationController, DraftProposalController],
      providers: [
        { provide: ProposeDraftService, useValue: proposals },
        { provide: ExplanationService, useValue: service },
        { provide: WORKSPACE_AUTHORIZATION, useValue: authorization },
      ],
    };
  }
}
