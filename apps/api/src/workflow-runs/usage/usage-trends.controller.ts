import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  usageRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { In, Route } from '../../workspaces/http/route.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { caller, type WorkflowRunsRequest } from '../http/request-context.js';
import { GetUsageTrendsUseCase } from './trends.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { runFailure } from '../../problems/context/normalize-context-errors.js';

@UseInterceptors(domainErrors(runFailure))
@Controller()
export class UsageTrendsController {
  constructor(private readonly trends: GetUsageTrendsUseCase) {}

  @Route(routes.trends)
  get(
    @Req() request: WorkflowRunsRequest & AbortableRequest,
    @In() { params, query }: RouteInput<typeof routes.trends>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.trends.execute({
        ...caller(request, params),
        period: query.period ?? '30d',
        signal,
      }),
    );
  }
}
