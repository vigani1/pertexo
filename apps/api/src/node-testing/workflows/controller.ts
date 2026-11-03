import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  workflowTestRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { In, Route } from '../../workspaces/http/route.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import { WorkflowTestsUseCase } from './workflow-tests.service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { nodeTestingFailure } from '../../problems/context/normalize.js';
import { draftContext, type DraftRequest } from '../draft-context.js';

@UseInterceptors(domainErrors(nodeTestingFailure))
@Controller()
export class WorkflowTestsController {
  constructor(private readonly tests: WorkflowTestsUseCase) {}

  @Route(routes.prepare)
  prepare(
    @Req() request: DraftRequest,
    @In() { params }: RouteInput<typeof routes.prepare>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tests.prepare({ ...draftContext(request, params), signal }),
    );
  }

  @Route(routes.list)
  list(
    @Req() request: DraftRequest,
    @In() { params }: RouteInput<typeof routes.list>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tests.list({ ...draftContext(request, params), signal }),
    );
  }

  @Route(routes.get)
  get(
    @Req() request: DraftRequest,
    @In() { params }: RouteInput<typeof routes.get>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tests.get({
        ...draftContext(request, params),
        runId: params.runId,
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
      this.tests.start({
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
      this.tests.cancel({
        ...draftContext(request, params),
        runId: params.runId,
        signal,
      }),
    );
  }
}
