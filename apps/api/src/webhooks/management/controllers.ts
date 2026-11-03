import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  webhookRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { authenticatedSession } from '../../workspaces/index.js';
import { In, Route } from '../../workspaces/http/route.js';
import type { IdentityWorkspaceRequest } from '../../workspaces/types.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { WebhookManagementService } from './service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;
type Command = RouteInput<typeof routes.provision>;

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WebhookManagementController {
  public constructor(private readonly service: WebhookManagementService) {}

  @Route(routes.list)
  public list(
    @Req() request: Request,
    @In() { params }: RouteInput<typeof routes.list>,
  ) {
    return this.service.list({
      ...params,
      actorId: authenticatedSession(request).userId,
    });
  }

  @Route(routes.deliveries)
  public deliveries(
    @Req() request: Request,
    @In() { params, query }: RouteInput<typeof routes.deliveries>,
  ) {
    return this.service.listDeliveries({
      ...params,
      actorId: authenticatedSession(request).userId,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.after === undefined ? {} : { after: query.after }),
    });
  }

  @Route(routes.provision)
  public provision(@Req() request: Request, @In() input: Command) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.provision(command(request, input, signal)),
    );
  }

  @Route(routes.configureAuthentication)
  public configureAuthentication(
    @Req() request: Request,
    @In() input: RouteInput<typeof routes.configureAuthentication>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.configureAuthentication({
        ...command(request, input, signal),
        authentication: input.body,
      }),
    );
  }

  @Route(routes.rotateEndpoint)
  public rotateEndpoint(@Req() request: Request, @In() input: Command) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.rotateEndpoint(command(request, input, signal)),
    );
  }

  @Route(routes.rotateSecret)
  public rotateSecret(
    @Req() request: Request,
    @In() input: RouteInput<typeof routes.rotateSecret>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.rotateSecret({
        ...command(request, input, signal),
        endpointKey: input.body.endpointKey,
      }),
    );
  }
}

function command(
  request: Request,
  { params, idempotencyKey }: Pick<Command, 'params' | 'idempotencyKey'>,
  signal: AbortSignal,
) {
  return {
    ...params,
    actorId: authenticatedSession(request).userId,
    idempotencyKey,
    signal,
  };
}
