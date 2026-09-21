import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';

import { RateLimit } from '../platform/rate-limit/metadata.js';
import { projectAuthenticatedWorkspaceContext } from './authenticated-command-context.js';
import { requestIdempotencyKey } from './controllers.js';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  WorkspaceMemberManageGuard,
} from './guards.js';
import { WorkspaceInvitationManagementUseCase } from './invitation-management-use-cases.js';
import { requestIdentifier, traceIdentifier } from './request-identifiers.js';
import {
  workspaceIdParamSchema,
  workspaceInvitationParamsSchema,
  workspaceInvitationsQuerySchema,
  type CookieResponse,
  type IdentityWorkspaceRequest,
} from './types.js';

@Controller('v1/workspaces')
export class WorkspaceInvitationsController {
  public constructor(
    private readonly invitations: WorkspaceInvitationManagementUseCase,
  ) {}

  @Get(':workspaceId/invitations')
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, WorkspaceMemberManageGuard)
  public async list(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    const { workspaceId } = workspaceIdParamSchema.parse(params);
    const parsed = workspaceInvitationsQuerySchema.parse(query ?? {});
    response.header('Cache-Control', 'private, no-store');
    return this.invitations.list({
      actor: projectAuthenticatedWorkspaceContext(request, workspaceId).actor,
      routeWorkspaceId: workspaceId,
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.after === undefined ? {} : { after: parsed.after }),
    });
  }

  @Post(':workspaceId/invitations')
  @HttpCode(202)
  @RateLimit('ordinary_mutation')
  @UseGuards(
    SessionAuthenticationGuard,
    CsrfProtectionGuard,
    WorkspaceMemberManageGuard,
  )
  public create(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId } = workspaceIdParamSchema.parse(params);
    return this.invitations.create({
      actor: projectAuthenticatedWorkspaceContext(request, workspaceId).actor,
      routeWorkspaceId: workspaceId,
      request: body,
      idempotencyKey: requestIdempotencyKey(request),
      requestId: requestIdentifier(request),
      ...optionalTrace(request),
    });
  }

  @Post(':workspaceId/invitations/:invitationId/resend')
  @HttpCode(202)
  @RateLimit('ordinary_mutation')
  @UseGuards(
    SessionAuthenticationGuard,
    CsrfProtectionGuard,
    WorkspaceMemberManageGuard,
  )
  public resend(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.change(request, params, body, 'resend');
  }

  @Post(':workspaceId/invitations/:invitationId/revoke')
  @HttpCode(202)
  @RateLimit('ordinary_mutation')
  @UseGuards(
    SessionAuthenticationGuard,
    CsrfProtectionGuard,
    WorkspaceMemberManageGuard,
  )
  public revoke(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.change(request, params, body, 'revoke');
  }

  private change(
    request: IdentityWorkspaceRequest,
    params: unknown,
    body: unknown,
    operation: 'resend' | 'revoke',
  ) {
    const { workspaceId, invitationId } =
      workspaceInvitationParamsSchema.parse(params);
    const input = {
      actor: projectAuthenticatedWorkspaceContext(request, workspaceId).actor,
      routeWorkspaceId: workspaceId,
      invitationId,
      request: body,
      idempotencyKey: requestIdempotencyKey(request),
      requestId: requestIdentifier(request),
      ...optionalTrace(request),
    };
    return operation === 'resend'
      ? this.invitations.resend(input)
      : this.invitations.revoke(input);
  }
}

function optionalTrace(request: IdentityWorkspaceRequest) {
  const traceId = traceIdentifier(request);
  return traceId === undefined ? {} : { traceId };
}
