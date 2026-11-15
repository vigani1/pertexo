import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  usageRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { In, Route } from '../../platform/http/route.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import type { WorkflowRunsRequest } from '../http/request-context.js';
import { GetUsageTrendsService } from './trends.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { runFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

@UseInterceptors(domainErrors(runFailure))
@Controller()
export class UsageTrendsController {
  constructor(private readonly trends: GetUsageTrendsService) {}

  @Route(routes.trends)
  get(
    @Req() request: WorkflowRunsRequest & AbortableRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { query }: RouteInput<typeof routes.trends>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.trends.execute({
        ...serviceCaller(caller),
        period: query.period ?? '30d',
        signal,
      }),
    );
  }
}
