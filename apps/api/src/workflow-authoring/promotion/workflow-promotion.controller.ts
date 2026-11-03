import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  promotionRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../workspaces/http/route.js';
import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import { singleRequestHeader } from '../../platform/http/request-headers.js';
import type { WorkflowAuthoringRequest } from '../workflow-transport.js';
import { WorkflowPromotionUseCase } from './workflow-promotion.service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowPromotionController {
  constructor(private readonly promotions: WorkflowPromotionUseCase) {}

  @Route(routes.settings)
  settings(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params }: RouteInput<typeof routes.settings>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.promotions.settings({ ...context(request, params), signal }),
    );
  }

  @Route(routes.setTarget)
  setTarget(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.setTarget>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.promotions.setTarget({
        ...context(request, params),
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.candidates)
  candidates(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, query }: RouteInput<typeof routes.candidates>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.promotions.candidates({
        ...context(request, params),
        request: query,
        signal,
      }),
    );
  }

  @Route(routes.history)
  history(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, query }: RouteInput<typeof routes.history>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.promotions.history({
        ...context(request, params),
        request: query,
        signal,
      }),
    );
  }

  @Route(routes.preview)
  preview(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body }: RouteInput<typeof routes.preview>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.promotions.preview({
        ...context(request, params),
        request: body,
        signal,
      }),
    );
  }

  @Route(routes.apply)
  apply(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.apply>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.promotions.apply({
        ...context(request, params),
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }
}

/** Promotion keys records by the lower-case workspace ID, whatever the path's case. */
function context(
  request: WorkflowAuthoringRequest,
  params: Readonly<{ workspaceId: string }>,
) {
  const workspaceId = params.workspaceId.toLowerCase();
  const traceparent = singleRequestHeader(request.headers, 'traceparent');
  return {
    ...projectAuthenticatedWorkspaceContext(request, workspaceId),
    routeWorkspaceId: workspaceId,
    ...(traceparent === undefined ? {} : { traceparent }),
  };
}
