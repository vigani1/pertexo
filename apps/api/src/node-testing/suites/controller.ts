import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  workflowTestSuiteRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { In, Route } from '../../workspaces/http/route.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import { WorkflowTestSuitesUseCase } from './use-case.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { nodeTestingFailure } from '../../problems/context/normalize.js';
import { draftContext, type DraftRequest } from '../draft-context.js';

@UseInterceptors(domainErrors(nodeTestingFailure))
@Controller()
export class WorkflowTestSuitesController {
  constructor(private readonly suites: WorkflowTestSuitesUseCase) {}

  @Route(routes.prepare)
  prepare(
    @Req() request: DraftRequest,
    @In() { params }: RouteInput<typeof routes.prepare>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.suites.prepare({ ...draftContext(request, params), signal }),
    );
  }

  @Route(routes.list)
  list(
    @Req() request: DraftRequest,
    @In() { params }: RouteInput<typeof routes.list>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.suites.list({ ...draftContext(request, params), signal }),
    );
  }

  @Route(routes.get)
  get(
    @Req() request: DraftRequest,
    @In() { params }: RouteInput<typeof routes.get>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.suites.get({
        ...draftContext(request, params),
        suiteId: params.suiteId,
        signal,
      }),
    );
  }

  @Route(routes.report)
  report(
    @Req() request: DraftRequest,
    @In() { params }: RouteInput<typeof routes.report>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.suites.report({
        ...draftContext(request, params),
        suiteId: params.suiteId,
        ordinal: params.ordinal,
        signal,
      }),
    );
  }

  @Route(routes.start)
  start(
    @Req() request: DraftRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.start>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.suites.start({
        ...draftContext(request, params),
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.cancel)
  cancel(
    @Req() request: DraftRequest,
    @In() { params }: RouteInput<typeof routes.cancel>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.suites.cancel({
        ...draftContext(request, params),
        suiteId: params.suiteId,
        signal,
      }),
    );
  }
}
