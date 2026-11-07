import { traceparent } from '../../platform/http/tracing-headers.js';
import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  publicationReviewRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../workspaces/http/route.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import { parseStrongIfMatch } from '../http/preconditions.js';
import { requestHeaderValue } from '../../platform/http/request-headers.js';
import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import type { WorkflowAuthoringRequest } from '../workflow-authoring-request.js';
import { PublicationReviewUseCase } from './publication-review.service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize-context-errors.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowPublicationReviewController {
  constructor(private readonly controls: PublicationReviewUseCase) {}

  @Route(routes.overview)
  async overview(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params }: RouteInput<typeof routes.overview>,
  ) {
    return await withRequestOperationSignal(request, (signal) =>
      this.controls.overview({
        ...context(request, params.workspaceId),
        workflowId: params.workflowId,
        signal,
      }),
    );
  }

  /** Reviews the exact draft the requester saw, named by its `If-Match`. */
  @Route(routes.request)
  async create(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.request>,
  ) {
    const representationTag = parseStrongIfMatch(
      requestHeaderValue(request.headers, 'if-match'),
    );
    return await withRequestOperationSignal(request, (signal) =>
      this.controls.request({
        ...context(request, params.workspaceId),
        workflowId: params.workflowId,
        request: body,
        representationTag,
        idempotencyKey,
        signal,
      }),
    );
  }
}

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class PublicationReviewController {
  constructor(private readonly controls: PublicationReviewUseCase) {}

  @Route(routes.read)
  async read(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params }: RouteInput<typeof routes.read>,
  ) {
    return await withRequestOperationSignal(request, (signal) =>
      this.controls.read({
        ...context(request, params.workspaceId),
        reviewId: params.requestId,
        signal,
      }),
    );
  }

  @Route(routes.decide)
  async decide(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.decide>,
  ) {
    return await withRequestOperationSignal(request, (signal) =>
      this.controls.decide({
        ...context(request, params.workspaceId),
        reviewId: params.requestId,
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }
}
function context(request: WorkflowAuthoringRequest, workspaceId: string) {
  return {
    ...projectAuthenticatedWorkspaceContext(request, workspaceId),
    routeWorkspaceId: workspaceId,
    ...traceparent(request),
  };
}
