import { Controller, Req, UseInterceptors } from '@nestjs/common';
import { connectionRoutes, type RouteInput } from '@pertexo/contracts/server';
import { In, Route } from '../../platform/http/route.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { connectionFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';
import type { ConnectionRequest } from '../connection-request.js';
import { LookupConnectionOptionsService } from './lookup-options.service.js';

@UseInterceptors(domainErrors(connectionFailure))
@Controller()
export class LookupConnectionOptionsController {
  public constructor(private readonly lookup: LookupConnectionOptionsService) {}

  @Route(connectionRoutes.lookup)
  public execute(
    @Req() request: ConnectionRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body }: RouteInput<typeof connectionRoutes.lookup>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.lookup.execute({
        ...serviceCaller(caller),
        connectionId: params.connectionId,
        request: body,
        signal,
      }),
    );
  }
}
