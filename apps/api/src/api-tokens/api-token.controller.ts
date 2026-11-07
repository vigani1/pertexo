import {
  Controller,
  Get,
  Inject,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { apiTokenInfoResponseSchema } from '@pertexo/contracts';
import {
  apiTokenRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../workspaces/http/route.js';
import { AutomationAuthenticationGuard } from '../authentication/automation/guard.js';
import { SESSION_AUTHORITY } from '../workspaces/tokens.js';
import type { IdentitySessionAuthority } from '../workspaces/ports.js';
import type {
  IdentityWorkspaceRequest,
  CookieResponse,
} from '../workspaces/workspace-transport.js';
import {
  authenticatedSession,
  requireSignInEvidence,
} from '../workspaces/http/guards.js';
import { authenticatedRequestIdentifiers } from '../workspaces/request/authenticated-context.js';
import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { ApiTokenManagement } from './api-token.service.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { workspaceFailure } from '../problems/context/normalize-context-errors.js';

@UseInterceptors(domainErrors(workspaceFailure))
@Controller()
export class ApiTokenController {
  public constructor(
    private readonly management: ApiTokenManagement,
    @Inject(SESSION_AUTHORITY)
    private readonly sessions: IdentitySessionAuthority,
  ) {}

  @Route(routes.list)
  public list(
    @Req() request: IdentityWorkspaceRequest,
    @In() { params, query }: RouteInput<typeof routes.list>,
  ) {
    return this.management.list({
      workspaceId: params.workspaceId,
      ownerUserId: authenticatedSession(request).userId,
      query,
    });
  }

  @Route(routes.create)
  public async create(
    @Req() request: IdentityWorkspaceRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.create>,
  ) {
    const evidence = await requireSignInEvidence(request, this.sessions);
    return this.management.create({
      ...command(request, params.workspaceId, idempotencyKey),
      request: body,
      signedInAt: evidence.signedInAt,
    });
  }

  @Route(routes.revoke)
  public revoke(
    @Req() request: IdentityWorkspaceRequest,
    @In() { params, idempotencyKey }: RouteInput<typeof routes.revoke>,
  ) {
    return this.management.revoke({
      ...command(request, params.workspaceId, idempotencyKey),
      tokenId: params.tokenId,
    });
  }
}

/** Outside a workspace path: the credential itself says which workspace it's for. */
@UseInterceptors(domainErrors(workspaceFailure))
@Controller('v1/token')
export class CurrentApiTokenController {
  @Get()
  @RateLimit('authenticated_read')
  @UseGuards(AutomationAuthenticationGuard)
  public read(
    @Req() request: IdentityWorkspaceRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    response.header('Cache-Control', 'private, no-store');
    const token = request.verifiedApiToken;
    if (token === undefined)
      return throwApplicationError(applicationError('auth.unauthenticated'));
    return apiTokenInfoResponseSchema.parse({
      id: token.tokenId,
      workspaceId: token.workspaceId,
      name: token.name,
      scopes: token.scopes,
      expiresAt: token.expiresAt.toISOString(),
    });
  }
}
function command(
  request: IdentityWorkspaceRequest,
  workspaceId: string,
  idempotencyKey: string,
) {
  return {
    workspaceId,
    ownerUserId: authenticatedSession(request).userId,
    idempotencyKey,
    ...authenticatedRequestIdentifiers(request),
  };
}
