import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  stepSampleRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { In, Route } from '../../platform/http/route.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import {
  draftContext as context,
  type DraftRequest as Request,
} from '../draft-context.js';
import { StepSamplesService } from './step-samples.service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { nodeTestingFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

@UseInterceptors(domainErrors(nodeTestingFailure))
@Controller()
export class StepSamplesController {
  constructor(private readonly samples: StepSamplesService) {}

  @Route(routes.list)
  list(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.list>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.samples.list({ ...context(caller, params), signal }),
    );
  }

  @Route(routes.get)
  get(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.get>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.samples.get({
        ...context(caller, params),
        nodeId: params.nodeId,
        signal,
      }),
    );
  }

  @Route(routes.put)
  put(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.put>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.samples.put({
        ...context(caller, params),
        nodeId: params.nodeId,
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.remove)
  remove(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.remove>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.samples.remove({
        ...context(caller, params),
        nodeId: params.nodeId,
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }
}
