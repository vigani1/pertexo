import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  connectionRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import { In, Route } from '../../platform/http/route.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import {
  CreateConnectionService,
  GetConnectionService,
  ListConnectionsService,
  RevokeConnectionService,
  RotateConnectionSecretService,
} from '../management/connection-management.js';
import { LookupSlackChannelsService } from '../failure-notifications/slack-channel-lookup.js';
import { TestConnectionService } from '../testing/test-connection.js';
import type { ConnectionRequest } from '../connection-request.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { connectionFailure } from '../../problems/context/normalize-context-errors.js';

@UseInterceptors(domainErrors(connectionFailure))
@Controller()
export class ConnectionsController {
  // Nest resolves these dependencies positionally; grouping them would change DI.
  // eslint-disable-next-line max-params
  public constructor(
    private readonly listConnections: ListConnectionsService,
    private readonly getConnection: GetConnectionService,
    private readonly createConnection: CreateConnectionService,
    private readonly rotateSecret: RotateConnectionSecretService,
    private readonly revokeConnection: RevokeConnectionService,
    private readonly testConnection: TestConnectionService,
    private readonly lookupSlackChannels: LookupSlackChannelsService,
  ) {}

  @Route(routes.list)
  public list(
    @Req() request: ConnectionRequest,
    @In() { params, query }: RouteInput<typeof routes.list>,
  ) {
    return this.listConnections.execute({
      ...context(request, params),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.after === undefined ? {} : { after: query.after }),
    });
  }

  @Route(routes.get)
  public read(
    @Req() request: ConnectionRequest,
    @In() { params }: RouteInput<typeof routes.get>,
  ) {
    return this.getConnection.execute({
      ...context(request, params),
      connectionId: params.connectionId,
    });
  }

  @Route(routes.create)
  public create(
    @Req() request: ConnectionRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.create>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.createConnection.execute({
        ...context(request, params),
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.rotateSecret)
  public rotate(
    @Req() request: ConnectionRequest,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.rotateSecret>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.rotateSecret.execute({
        ...context(request, params),
        connectionId: params.connectionId,
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.revoke)
  public revoke(
    @Req() request: ConnectionRequest,
    @In() { params }: RouteInput<typeof routes.revoke>,
  ) {
    return this.revokeConnection.execute({
      ...context(request, params),
      connectionId: params.connectionId,
    });
  }

  /** ADR 046: bounded channel-name lookup; never fails for one channel. */
  @Route(routes.slackChannels)
  public slackChannels(
    @Req() request: ConnectionRequest,
    @In() { params, query }: RouteInput<typeof routes.slackChannels>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.lookupSlackChannels.execute({
        ...context(request, params),
        connectionId: params.connectionId,
        channelIds: query.channelIds,
        signal,
      }),
    );
  }

  @Route(routes.test)
  public test(
    @Req() request: ConnectionRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.test>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.testConnection.execute({
        ...context(request, params),
        connectionId: params.connectionId,
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }
}

/** Who is asking, in which workspace: what every connection service starts from. */
export function context(
  request: ConnectionRequest,
  { workspaceId }: Readonly<{ workspaceId: string }>,
) {
  return {
    ...projectAuthenticatedWorkspaceContext(request, workspaceId),
    routeWorkspaceId: workspaceId,
  };
}
