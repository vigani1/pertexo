import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  connectionRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { In, Route } from '../../workspaces/http/route.js';
import { ListConnectionUsageUseCase } from '../use-cases/usage.js';
import type { ConnectionRequest } from '../types.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { connectionFailure } from '../../problems/context/normalize.js';
import { context } from './connections.controller.js';

/** Registered only when usage can be read, so it stands apart from the others. */
@UseInterceptors(domainErrors(connectionFailure))
@Controller()
export class ConnectionUsageController {
  public constructor(private readonly usage: ListConnectionUsageUseCase) {}

  @Route(routes.usage)
  public list(
    @Req() request: ConnectionRequest,
    @In() { params, query }: RouteInput<typeof routes.usage>,
  ) {
    return this.usage.execute({
      ...context(request, params),
      connectionId: params.connectionId,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.after === undefined ? {} : { after: query.after }),
    });
  }
}
