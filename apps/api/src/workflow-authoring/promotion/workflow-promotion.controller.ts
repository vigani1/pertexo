import { traceparent } from '../../platform/http/tracing-headers.js';
import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  promotionRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../platform/http/route.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { WorkflowAuthoringRequest } from '../workflow-authoring-request.js';
import { WorkflowPromotionService } from './workflow-promotion.service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowPromotionController {
  constructor(private readonly promotions: WorkflowPromotionService) {}

  @Route(routes.settings)
  settings(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.promotions.settings({ ...context(caller, request), signal }),
    );
  }

  @Route(routes.setTarget)
  setTarget(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { body, idempotencyKey }: RouteInput<typeof routes.setTarget>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.promotions.setTarget({
        ...context(caller, request),
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.candidates)
  candidates(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { query }: RouteInput<typeof routes.candidates>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.promotions.candidates({
        ...context(caller, request),
        request: query,
        signal,
      }),
    );
  }

  @Route(routes.history)
  history(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { query }: RouteInput<typeof routes.history>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.promotions.history({
        ...context(caller, request),
        request: query,
        signal,
      }),
    );
  }

  @Route(routes.preview)
  preview(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { body }: RouteInput<typeof routes.preview>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.promotions.preview({
        ...context(caller, request),
        request: body,
        signal,
      }),
    );
  }

  @Route(routes.apply)
  apply(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { body, idempotencyKey }: RouteInput<typeof routes.apply>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.promotions.apply({
        ...context(caller, request),
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }
}

/** Promotion keys records by the lower-case workspace ID, whatever the path's case. */
function context(caller: WorkspaceCaller, request: WorkflowAuthoringRequest) {
  return {
    ...serviceCaller(caller),
    routeWorkspaceId: caller.workspaceId.toLowerCase(),
    ...traceparent(request),
  };
}
