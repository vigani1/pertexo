import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  workflowTestRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { In, Route } from '../../platform/http/route.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import { WorkflowTestsService } from './workflow-tests.service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { nodeTestingFailure } from '../../problems/context/normalize-context-errors.js';
import { draftContext, type DraftRequest } from '../draft-context.js';
import {
  Caller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

@UseInterceptors(domainErrors(nodeTestingFailure))
@Controller()
export class WorkflowTestsController {
  constructor(private readonly tests: WorkflowTestsService) {}

  @Route(routes.prepare)
  prepare(
    @Req() request: DraftRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.prepare>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tests.prepare({ ...draftContext(caller, params), signal }),
    );
  }

  @Route(routes.list)
  list(
    @Req() request: DraftRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.list>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tests.list({ ...draftContext(caller, params), signal }),
    );
  }

  @Route(routes.get)
  get(
    @Req() request: DraftRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.get>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tests.get({
        ...draftContext(caller, params),
        runId: params.runId,
        signal,
      }),
    );
  }

  @Route(routes.start)
  start(
    @Req() request: DraftRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.start>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tests.start({
        ...draftContext(caller, params),
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.cancel)
  cancel(
    @Req() request: DraftRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.cancel>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tests.cancel({
        ...draftContext(caller, params),
        runId: params.runId,
        signal,
      }),
    );
  }
}
