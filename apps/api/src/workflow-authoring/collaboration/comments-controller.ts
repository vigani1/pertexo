import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  collaborationRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../workspaces/http/route.js';
import { WorkflowCollaborationUseCase } from './use-case.js';
import { collaborationOperation } from './http.js';
import type { WorkflowAuthoringRequest } from '../types.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { collaborationFailure } from '../../problems/context/normalize.js';
@UseInterceptors(domainErrors(collaborationFailure))
@Controller()
export class WorkflowCommentsController {
  constructor(private readonly collaboration: WorkflowCollaborationUseCase) {}
  @Route(routes.list)
  async list(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, query }: RouteInput<typeof routes.list>,
  ) {
    return collaborationOperation(request, params, (scope, route) =>
      this.collaboration.list({ ...scope, ...route, query }),
    );
  }
  @Route(routes.people)
  async people(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, query }: RouteInput<typeof routes.people>,
  ) {
    return collaborationOperation(request, params, (scope, route) =>
      this.collaboration.people({ ...scope, ...route, query }),
    );
  }
  @Route(routes.read)
  async read(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, query }: RouteInput<typeof routes.read>,
  ) {
    return collaborationOperation(request, params, (scope, route) =>
      this.collaboration.read({ ...scope, ...route, query }),
    );
  }
  @Route(routes.create)
  async create(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.create>,
  ) {
    return collaborationOperation(request, params, (scope, route) =>
      this.collaboration.create({
        ...scope,
        ...route,
        request: body,
        idempotencyKey,
      }),
    );
  }
  @Route(routes.reply)
  async reply(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.reply>,
  ) {
    return collaborationOperation(request, params, (scope, route) =>
      this.collaboration.reply({
        ...scope,
        ...route,
        request: body,
        idempotencyKey,
      }),
    );
  }
  @Route(routes.edit)
  async edit(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.edit>,
  ) {
    return collaborationOperation(request, params, (scope, route) =>
      this.collaboration.edit({
        ...scope,
        ...route,
        request: body,
        idempotencyKey,
      }),
    );
  }
  @Route(routes.remove)
  async remove(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.remove>,
  ) {
    return collaborationOperation(request, params, (scope, route) =>
      this.collaboration.remove({
        ...scope,
        ...route,
        request: body,
        idempotencyKey,
      }),
    );
  }
  @Route(routes.setStatus)
  async setStatus(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.setStatus>,
  ) {
    return collaborationOperation(request, params, (scope, route) =>
      this.collaboration.setStatus({
        ...scope,
        ...route,
        request: body,
        idempotencyKey,
      }),
    );
  }
}
