import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  connectionRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

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
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

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
    @Caller() caller: WorkspaceCaller,
    @In() { query }: RouteInput<typeof routes.list>,
  ) {
    return this.listConnections.execute({
      ...serviceCaller(caller),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.after === undefined ? {} : { after: query.after }),
    });
  }

  @Route(routes.get)
  public read(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.get>,
  ) {
    return this.getConnection.execute({
      ...serviceCaller(caller),
      connectionId: params.connectionId,
    });
  }

  @Route(routes.create)
  public create(
    @Req() request: ConnectionRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { body, idempotencyKey }: RouteInput<typeof routes.create>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.createConnection.execute({
        ...serviceCaller(caller),
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.rotateSecret)
  public rotate(
    @Req() request: ConnectionRequest,
    @Caller() caller: WorkspaceCaller,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.rotateSecret>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.rotateSecret.execute({
        ...serviceCaller(caller),
        connectionId: params.connectionId,
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.revoke)
  public revoke(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.revoke>,
  ) {
    return this.revokeConnection.execute({
      ...serviceCaller(caller),
      connectionId: params.connectionId,
    });
  }

  /** ADR 046: bounded channel-name lookup; never fails for one channel. */
  @Route(routes.slackChannels)
  public slackChannels(
    @Req() request: ConnectionRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, query }: RouteInput<typeof routes.slackChannels>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.lookupSlackChannels.execute({
        ...serviceCaller(caller),
        connectionId: params.connectionId,
        channelIds: query.channelIds,
        signal,
      }),
    );
  }

  @Route(routes.test)
  public test(
    @Req() request: ConnectionRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.test>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.testConnection.execute({
        ...serviceCaller(caller),
        connectionId: params.connectionId,
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }
}
