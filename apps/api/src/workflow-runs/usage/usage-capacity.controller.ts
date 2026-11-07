import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  usageRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { In, Route } from '../../workspaces/http/route.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { caller, type WorkflowRunsRequest } from '../http/request-context.js';
import { GetUsageCapacityUseCase } from './capacity.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { runFailure } from '../../problems/context/normalize-context-errors.js';

@UseInterceptors(domainErrors(runFailure))
@Controller()
export class UsageCapacityController {
  public constructor(
    private readonly getUsageCapacity: GetUsageCapacityUseCase,
  ) {}

  @Route(routes.capacity)
  public getCapacity(
    @Req() request: WorkflowRunsRequest & AbortableRequest,
    @In() { params }: RouteInput<typeof routes.capacity>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.getUsageCapacity.execute({ ...caller(request, params), signal }),
    );
  }
}
