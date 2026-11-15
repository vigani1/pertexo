import { Controller, UseInterceptors } from '@nestjs/common';
import {
  connectionRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { In, Route } from '../../platform/http/route.js';
import { ListConnectionUsageService } from '../management/connection-usage.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { connectionFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

/** Registered only when usage can be read, so it stands apart from the others. */
@UseInterceptors(domainErrors(connectionFailure))
@Controller()
export class ConnectionUsageController {
  public constructor(private readonly usage: ListConnectionUsageService) {}

  @Route(routes.usage)
  public list(
    @Caller() caller: WorkspaceCaller,
    @In() { params, query }: RouteInput<typeof routes.usage>,
  ) {
    return this.usage.execute({
      ...serviceCaller(caller),
      connectionId: params.connectionId,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.after === undefined ? {} : { after: query.after }),
    });
  }
}
