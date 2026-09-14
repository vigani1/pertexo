import {
  Body,
  Controller,
  Delete,
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
import {
  authenticatedSession,
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  WorkspaceManageGuard,
  WorkspaceMemberReadGuard,
} from './guards.js';
import {
  CreateWorkspaceUseCase,
  GetCurrentUserUseCase,
  ListWorkspaceMembersUseCase,
  WorkspaceLifecycleUseCase,
} from './use-cases.js';
import {
  idempotencyKeySchema,
  workspaceDeletionRequestSchema,
  workspaceIdParamSchema,
  workspaceLifecycleOperationParamsSchema,
  workspaceMembersQuerySchema,
  type CookieResponse,
  type IdentityWorkspaceRequest,
} from './types.js';
import { requestIdentifier, traceIdentifier } from './request-identifiers.js';
import {
  optionalAuthorizedWorkspace,
  projectAuthenticatedWorkspaceContext,
} from './authenticated-command-context.js';

@Controller('v1/users')
export class UserController {
  public constructor(private readonly currentUser: GetCurrentUserUseCase) {}

  @Get('me')
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard)
  public async me(
    @Req() request: IdentityWorkspaceRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    response.header('Cache-Control', 'private, no-store');
    return this.currentUser.execute(authenticatedSession(request).userId);
  }
}

@Controller('v1/workspaces')
export class WorkspaceMembersController {
  public constructor(private readonly members: ListWorkspaceMembersUseCase) {}

  @Get(':workspaceId/members')
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, WorkspaceMemberReadGuard)
  public async list(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    const { workspaceId } = workspaceIdParamSchema.parse(params);
    const input = workspaceMembersQuerySchema.parse(query ?? {});
    const actor = lifecycleActorFrom(request, workspaceId);
    response.header('Cache-Control', 'private, no-store');
    return this.members.execute({
      actor,
      ...guardAuthorization(request),
      routeWorkspaceId: workspaceId,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
  }
}

@Controller('v1/workspaces')
export class WorkspaceController {
  public constructor(
    private readonly createWorkspace: CreateWorkspaceUseCase,
    private readonly lifecycle: WorkspaceLifecycleUseCase,
  ) {}

  @Post()
  @RateLimit('actor_mutation')
  @UseGuards(SessionAuthenticationGuard, CsrfProtectionGuard)
  public async create(
    @Req() request: IdentityWorkspaceRequest,
    @Body() body: unknown,
  ) {
    const session = authenticatedSession(request);
    return this.createWorkspace.execute({
      actorId: session.userId,
      idempotencyKey: requestIdempotencyKey(request),
      request: body,
      requestId: requestIdentifier(request),
      ...traceFields(traceIdentifier(request)),
    });
  }

  @Post(':workspaceId/deletion')
  @RateLimit('ordinary_mutation')
  @HttpCode(202)
  @UseGuards(
    SessionAuthenticationGuard,
    CsrfProtectionGuard,
    WorkspaceManageGuard,
  )
  public async requestDeletion(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId } = workspaceIdParamSchema.parse(params);
    const deletion = workspaceDeletionRequestSchema.parse(body ?? {});
    const actor = lifecycleActorFrom(request, workspaceId);
    const requestId = actor.requestId;
    const traceId = actor.traceId;
    return this.lifecycle.requestDeletion({
      actor,
      ...guardAuthorization(request),
      idempotencyKey: requestIdempotencyKey(request),
      routeWorkspaceId: workspaceId,
      reason: deletion.reason,
      requestId,
      ...traceFields(traceId),
    });
  }

  @Delete(':workspaceId/deletion')
  @RateLimit('ordinary_mutation')
  @HttpCode(202)
  @UseGuards(
    SessionAuthenticationGuard,
    CsrfProtectionGuard,
    WorkspaceManageGuard,
  )
  public async restore(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
  ) {
    const { workspaceId } = workspaceIdParamSchema.parse(params);
    const actor = lifecycleActorFrom(request, workspaceId);
    const requestId = actor.requestId;
    const traceId = actor.traceId;
    return this.lifecycle.restore({
      actor,
      ...guardAuthorization(request),
      idempotencyKey: requestIdempotencyKey(request),
      routeWorkspaceId: workspaceId,
      requestId,
      ...traceFields(traceId),
    });
  }

  @Get(':workspaceId/lifecycle-operations/:operationId')
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, WorkspaceManageGuard)
  public async readLifecycleOperation(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
  ) {
    const { workspaceId, operationId } =
      workspaceLifecycleOperationParamsSchema.parse(params);
    const actor = lifecycleActorFrom(request, workspaceId);
    return this.lifecycle.readOperation({
      actor,
      ...guardAuthorization(request),
      routeWorkspaceId: workspaceId,
      operationId,
    });
  }
}

function guardAuthorization(
  request: IdentityWorkspaceRequest,
): Pick<IdentityWorkspaceRequest, 'authorizedWorkspace'> {
  return optionalAuthorizedWorkspace(request);
}

function lifecycleActorFrom(
  request: IdentityWorkspaceRequest,
  workspaceId: string,
) {
  return projectAuthenticatedWorkspaceContext(request, workspaceId).actor;
}

function requestIdempotencyKey(request: IdentityWorkspaceRequest): string {
  const entry = Object.entries(request.headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'idempotency-key',
  );
  return idempotencyKeySchema.parse(entry?.[1]);
}

function traceFields(trace: string | undefined): Readonly<{
  traceId?: string;
}> {
  return trace === undefined ? {} : { traceId: trace };
}
