import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  invitationRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { In, Route } from '../../platform/http/route.js';
import { WorkspaceInvitationManagementService } from './management.js';
import type { IdentityWorkspaceRequest } from '../workspace-transport.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { workspaceFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  requestIdentifiers,
  type WorkspaceCaller,
} from '../request/caller.js';

@UseInterceptors(domainErrors(workspaceFailure))
@Controller()
export class WorkspaceInvitationsController {
  public constructor(
    private readonly invitations: WorkspaceInvitationManagementService,
  ) {}

  @Route(routes.list)
  public async list(
    @Caller() caller: WorkspaceCaller,
    @In() { params, query }: RouteInput<typeof routes.list>,
  ) {
    return this.invitations.list({
      actor: caller.actor,
      routeWorkspaceId: params.workspaceId,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.after === undefined ? {} : { after: query.after }),
    });
  }

  @Route(routes.create)
  public create(
    @Req() request: IdentityWorkspaceRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { body, idempotencyKey }: RouteInput<typeof routes.create>,
  ) {
    return this.invitations.create({
      ...command(caller, idempotencyKey),
      request: body,
    });
  }

  @Route(routes.resend)
  public resend(
    @Req() request: IdentityWorkspaceRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.resend>,
  ) {
    return this.invitations.resend({
      ...command(caller, idempotencyKey),
      invitationId: params.invitationId,
      request: body,
    });
  }

  @Route(routes.revoke)
  public revoke(
    @Req() request: IdentityWorkspaceRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.revoke>,
  ) {
    return this.invitations.revoke({
      ...command(caller, idempotencyKey),
      invitationId: params.invitationId,
      request: body,
    });
  }
}

/** Who asks, in which workspace, under which key. */
function command(caller: WorkspaceCaller, idempotencyKey: string) {
  return {
    actor: caller.actor,
    routeWorkspaceId: caller.workspaceId,
    idempotencyKey,
    ...requestIdentifiers(caller),
  };
}
