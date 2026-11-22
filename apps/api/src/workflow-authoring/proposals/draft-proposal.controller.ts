import { Controller, UseInterceptors } from '@nestjs/common';
import {
  assistantRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { In, Route } from '../../platform/http/route.js';
import { authoringFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';
import { ProposeDraftService } from './propose-draft.service.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class DraftProposalController {
  constructor(private readonly proposals: ProposeDraftService) {}

  @Route(routes.proposalDisclosure)
  disclosure(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.proposalDisclosure>,
  ) {
    return this.proposals.disclosure({
      ...serviceCaller(caller),
      workflowId: params.workflowId,
    });
  }

  @Route(routes.proposeDraft)
  propose(
    @Caller() caller: WorkspaceCaller,
    @In() { params, body }: RouteInput<typeof routes.proposeDraft>,
  ) {
    return this.proposals.propose(
      { ...serviceCaller(caller), workflowId: params.workflowId },
      body,
    );
  }
}
