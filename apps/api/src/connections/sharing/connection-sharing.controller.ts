import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  connectionRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { In, Route } from '../../workspaces/http/route.js';
import { context } from '../http/connections.controller.js';
import type { ConnectionRequest } from '../connection-request.js';
import { ConnectionSharingUseCases } from './connection-sharing.service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { connectionFailure } from '../../problems/context/normalize-context-errors.js';

@UseInterceptors(domainErrors(connectionFailure))
@Controller()
export class ConnectionSharingController {
  constructor(private readonly sharing: ConnectionSharingUseCases) {}

  @Route(routes.sharing)
  read(
    @Req() request: ConnectionRequest,
    @In() { params }: RouteInput<typeof routes.sharing>,
  ) {
    return this.sharing.read({
      ...context(request, params),
      connectionId: params.connectionId,
    });
  }

  @Route(routes.replaceSharing)
  replace(
    @Req() request: ConnectionRequest,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.replaceSharing>,
  ) {
    return this.sharing.replace({
      ...context(request, params),
      connectionId: params.connectionId,
      request: body,
      idempotencyKey,
    });
  }
}
