import { Controller, Req, UseInterceptors } from '@nestjs/common';
import { usageRoutes as routes } from '@pertexo/contracts/server';

import { Route } from '../../platform/http/route.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import type { WorkflowRunsRequest } from '../http/request-context.js';
import { GetUsageCapacityService } from './capacity.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { runFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

@UseInterceptors(domainErrors(runFailure))
@Controller()
export class UsageCapacityController {
  public constructor(
    private readonly getUsageCapacity: GetUsageCapacityService,
  ) {}

  @Route(routes.capacity)
  public getCapacity(
    @Req() request: WorkflowRunsRequest & AbortableRequest,
    @Caller() caller: WorkspaceCaller,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.getUsageCapacity.execute({ ...serviceCaller(caller), signal }),
    );
  }
}
