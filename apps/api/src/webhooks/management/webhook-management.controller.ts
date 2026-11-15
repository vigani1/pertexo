import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  webhookRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { In, Route } from '../../platform/http/route.js';
import type { IdentityWorkspaceRequest } from '../../workspaces/workspace-transport.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { WebhookManagementService } from './webhook-management.service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  storeCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;
type Command = RouteInput<typeof routes.provision>;

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WebhookManagementController {
  public constructor(private readonly service: WebhookManagementService) {}

  @Route(routes.list)
  public list(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.list>,
  ) {
    return this.service.list({
      ...params,
      actorId: caller.actor.actorId,
    });
  }

  @Route(routes.deliveries)
  public deliveries(
    @Caller() caller: WorkspaceCaller,
    @In() { params, query }: RouteInput<typeof routes.deliveries>,
  ) {
    return this.service.listDeliveries({
      ...params,
      actorId: caller.actor.actorId,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.after === undefined ? {} : { after: query.after }),
    });
  }

  @Route(routes.provision)
  public provision(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() input: Command,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.provision(command(caller, input, signal)),
    );
  }

  @Route(routes.configureAuthentication)
  public configureAuthentication(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() input: RouteInput<typeof routes.configureAuthentication>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.configureAuthentication({
        ...command(caller, input, signal),
        authentication: input.body,
      }),
    );
  }

  @Route(routes.rotateEndpoint)
  public rotateEndpoint(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() input: Command,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.rotateEndpoint(command(caller, input, signal)),
    );
  }

  @Route(routes.rotateSecret)
  public rotateSecret(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() input: RouteInput<typeof routes.rotateSecret>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.rotateSecret({
        ...command(caller, input, signal),
        endpointKey: input.body.endpointKey,
      }),
    );
  }
}

function command(
  caller: WorkspaceCaller,
  { params, idempotencyKey }: Pick<Command, 'params' | 'idempotencyKey'>,
  signal: AbortSignal,
) {
  return {
    ...params,
    ...storeCaller(caller),
    idempotencyKey,
    signal,
  };
}
