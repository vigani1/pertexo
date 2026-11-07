import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  invitationRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { projectAuthenticatedWorkspaceContext } from '../request/authenticated-context.js';
import { In, Route } from '../http/route.js';
import { WorkspaceInvitationManagementUseCase } from './management.js';
import { requestIdentifier, traceIdentifier } from '../request/identifiers.js';
import type { IdentityWorkspaceRequest } from '../workspace-transport.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { workspaceFailure } from '../../problems/context/normalize-context-errors.js';

@UseInterceptors(domainErrors(workspaceFailure))
@Controller()
export class WorkspaceInvitationsController {
  public constructor(
    private readonly invitations: WorkspaceInvitationManagementUseCase,
  ) {}

  @Route(routes.list)
  public async list(
    @Req() request: IdentityWorkspaceRequest,
    @In() { params, query }: RouteInput<typeof routes.list>,
  ) {
    return this.invitations.list({
      actor: projectAuthenticatedWorkspaceContext(request, params.workspaceId)
        .actor,
      routeWorkspaceId: params.workspaceId,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.after === undefined ? {} : { after: query.after }),
    });
  }

  @Route(routes.create)
  public create(
    @Req() request: IdentityWorkspaceRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.create>,
  ) {
    return this.invitations.create({
      ...command(request, params.workspaceId, idempotencyKey),
      request: body,
    });
  }

  @Route(routes.resend)
  public resend(
    @Req() request: IdentityWorkspaceRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.resend>,
  ) {
    return this.invitations.resend({
      ...command(request, params.workspaceId, idempotencyKey),
      invitationId: params.invitationId,
      request: body,
    });
  }

  @Route(routes.revoke)
  public revoke(
    @Req() request: IdentityWorkspaceRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.revoke>,
  ) {
    return this.invitations.revoke({
      ...command(request, params.workspaceId, idempotencyKey),
      invitationId: params.invitationId,
      request: body,
    });
  }
}

/** Who asks, in which workspace, under which key. */
function command(
  request: IdentityWorkspaceRequest,
  workspaceId: string,
  idempotencyKey: string,
) {
  return {
    actor: projectAuthenticatedWorkspaceContext(request, workspaceId).actor,
    routeWorkspaceId: workspaceId,
    idempotencyKey,
    requestId: requestIdentifier(request),
    ...optionalTrace(request),
  };
}

function optionalTrace(request: IdentityWorkspaceRequest) {
  const traceId = traceIdentifier(request);
  return traceId === undefined ? {} : { traceId };
}
