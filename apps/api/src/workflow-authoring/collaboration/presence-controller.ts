import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  collaborationRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../workspaces/http/route.js';
import { WorkflowCollaborationUseCase } from './workflow-collaboration.service.js';
import { collaborationOperation } from './http.js';
import type { WorkflowAuthoringRequest } from '../workflow-authoring-request.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { collaborationFailure } from '../../problems/context/normalize-context-errors.js';
@UseInterceptors(domainErrors(collaborationFailure))
@Controller()
export class WorkflowPresenceController {
  constructor(private readonly collaboration: WorkflowCollaborationUseCase) {}
  @Route(routes.presence)
  async read(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, query }: RouteInput<typeof routes.presence>,
  ) {
    return collaborationOperation(request, params, (scope, route) =>
      this.collaboration.presence({ ...scope, ...route, query }),
    );
  }
  @Route(routes.heartbeat)
  async heartbeat(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body }: RouteInput<typeof routes.heartbeat>,
  ) {
    return collaborationOperation(request, params, (scope, route) =>
      this.collaboration.heartbeat({ ...scope, ...route, request: body }),
    );
  }
  @Route(routes.leave)
  async leave(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params }: RouteInput<typeof routes.leave>,
  ) {
    return collaborationOperation(request, params, (scope, route) =>
      this.collaboration.leave({ ...scope, ...route }),
    );
  }
}
