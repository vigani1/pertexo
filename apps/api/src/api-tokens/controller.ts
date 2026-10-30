import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { z } from 'zod';
import { SESSION_AUTHORITY } from '../workspaces/tokens.js';
import type { IdentitySessionAuthority } from '../workspaces/ports.js';
import type {
  IdentityWorkspaceRequest,
  CookieResponse,
} from '../workspaces/types.js';
import {
  authenticatedSession,
  CsrfProtectionGuard,
  requireSignInEvidence,
  SessionAuthenticationGuard,
  WorkspaceMemberBrowseGuard,
  WorkspaceMembershipGuard,
} from '../workspaces/http/guards.js';
import { authenticatedRequestIdentifiers } from '../workspaces/request/authenticated-context.js';
import { requestIdempotencyKey } from '../platform/http/index.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { ApiTokenManagement } from './use-cases.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { workspaceFailure } from '../problems/context/normalize.js';

const workspaceParams = z.object({ workspaceId: z.uuid() }).strict();
const tokenParams = workspaceParams.extend({ tokenId: z.uuid() }).strict();

@UseInterceptors(domainErrors(workspaceFailure))
@Controller('v1/workspaces/:workspaceId/api-tokens')
export class ApiTokenController {
  public constructor(
    private readonly management: ApiTokenManagement,
    @Inject(SESSION_AUTHORITY)
    private readonly sessions: IdentitySessionAuthority,
  ) {}
  @Get()
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, WorkspaceMemberBrowseGuard)
  public list(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    response.header('Cache-Control', 'private, no-store');
    return this.management.list({
      workspaceId: workspaceParams.parse(params).workspaceId,
      ownerUserId: authenticatedSession(request).userId,
      query,
    });
  }
  @Post()
  @HttpCode(201)
  @RateLimit('ordinary_mutation')
  @UseGuards(
    SessionAuthenticationGuard,
    WorkspaceMembershipGuard,
    CsrfProtectionGuard,
  )
  public async create(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    response.header('Cache-Control', 'private, no-store');
    const evidence = await requireSignInEvidence(request, this.sessions);
    return this.management.create({
      ...command(request, workspaceParams.parse(params).workspaceId),
      request: body,
      signedInAt: evidence.signedInAt,
    });
  }
  @Post(':tokenId/revoke')
  @HttpCode(200)
  @RateLimit('ordinary_mutation')
  @UseGuards(
    SessionAuthenticationGuard,
    WorkspaceMembershipGuard,
    CsrfProtectionGuard,
  )
  public revoke(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    response.header('Cache-Control', 'private, no-store');
    const route = tokenParams.parse(params);
    return this.management.revoke({
      ...command(request, route.workspaceId),
      tokenId: route.tokenId,
      request: body,
    });
  }
}
function command(request: IdentityWorkspaceRequest, workspaceId: string) {
  return {
    workspaceId,
    ownerUserId: authenticatedSession(request).userId,
    idempotencyKey: requestIdempotencyKey(request.headers),
    ...authenticatedRequestIdentifiers(request),
  };
}
