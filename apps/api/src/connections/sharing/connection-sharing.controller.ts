import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  connectionRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { In, Route } from '../../platform/http/route.js';
import type { ConnectionRequest } from '../connection-request.js';
import { ConnectionSharingServices } from './connection-sharing.service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { connectionFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

@UseInterceptors(domainErrors(connectionFailure))
@Controller()
export class ConnectionSharingController {
  constructor(private readonly sharing: ConnectionSharingServices) {}

  @Route(routes.sharing)
  read(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.sharing>,
  ) {
    return this.sharing.read({
      ...serviceCaller(caller),
      connectionId: params.connectionId,
    });
  }

  @Route(routes.replaceSharing)
  replace(
    @Req() request: ConnectionRequest,
    @Caller() caller: WorkspaceCaller,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.replaceSharing>,
  ) {
    return this.sharing.replace({
      ...serviceCaller(caller),
      connectionId: params.connectionId,
      request: body,
      idempotencyKey,
    });
  }
}
