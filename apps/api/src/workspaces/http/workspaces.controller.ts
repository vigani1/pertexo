import { Controller, Req, UseInterceptors } from '@nestjs/common';
import { sessionRoutes } from '@pertexo/contracts/server';

import {
  workspaceRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { workspaceFailure } from '../../problems/context/normalize-context-errors.js';
import { RenameWorkspaceUseCase } from '../commands/rename.js';
import { UpdateUserProfileUseCase } from '../commands/user-profile.js';
import { RemoveWorkspaceMemberUseCase } from '../members/removal.js';
import {
  optionalAuthorizedWorkspace,
  projectAuthenticatedWorkspaceContext,
} from '../request/authenticated-context.js';
import { requestIdentifier, traceIdentifier } from '../request/identifiers.js';
import { memberCommand } from '../request/member-commands.js';
import type { IdentityWorkspaceRequest } from '../workspace-transport.js';
import {
  ChangeWorkspaceMemberRoleUseCase,
  CreateWorkspaceUseCase,
  GetCurrentUserUseCase,
  ListAccessibleWorkspacesUseCase,
  ListWorkspaceMembersUseCase,
  WorkspaceLifecycleUseCase,
} from '../workspaces.service.js';
import { authenticatedSession } from './guards.js';
import { In, Route } from './route.js';

@UseInterceptors(domainErrors(workspaceFailure))
@Controller()
export class UserController {
  public constructor(
    private readonly currentUser: GetCurrentUserUseCase,
    private readonly profile: UpdateUserProfileUseCase,
  ) {}

  @Route(sessionRoutes.me)
  public async me(@Req() request: IdentityWorkspaceRequest) {
    return this.currentUser.execute(authenticatedSession(request).userId);
  }

  @Route(sessionRoutes.updateMe)
  public async updateMe(
    @Req() request: IdentityWorkspaceRequest,
    @In() { body, idempotencyKey }: RouteInput<typeof sessionRoutes.updateMe>,
  ) {
    return this.profile.execute({
      actorUserId: authenticatedSession(request).userId,
      request: body,
      idempotencyKey: idempotencyKey,
    });
  }
}

@UseInterceptors(domainErrors(workspaceFailure))
@Controller()
export class WorkspaceDiscoveryController {
  public constructor(
    private readonly workspaces: ListAccessibleWorkspacesUseCase,
  ) {}

  @Route(routes.list)
  public async list(
    @Req() request: IdentityWorkspaceRequest,
    @In() { query }: RouteInput<typeof routes.list>,
  ) {
    return this.workspaces.execute(authenticatedSession(request).userId, {
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.after === undefined ? {} : { after: query.after }),
    });
  }
}

@UseInterceptors(domainErrors(workspaceFailure))
@Controller()
export class WorkspaceMembersController {
  public constructor(
    private readonly members: ListWorkspaceMembersUseCase,
    private readonly roleChange: ChangeWorkspaceMemberRoleUseCase,
    private readonly removal: RemoveWorkspaceMemberUseCase,
  ) {}

  @Route(routes.members)
  public async list(
    @Req() request: IdentityWorkspaceRequest,
    @In() { params, query }: RouteInput<typeof routes.members>,
  ) {
    return this.members.execute({
      actor: actorFrom(request, params.workspaceId),
      ...optionalAuthorizedWorkspace(request),
      routeWorkspaceId: params.workspaceId,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.after === undefined ? {} : { after: query.after }),
    });
  }

  @Route(routes.changeRole)
  public async changeRole(
    @Req() request: IdentityWorkspaceRequest,
    @In() input: RouteInput<typeof routes.changeRole>,
  ) {
    return this.roleChange.execute(memberCommand(request, input));
  }

  @Route(routes.remove)
  public async remove(
    @Req() request: IdentityWorkspaceRequest,
    @In() input: RouteInput<typeof routes.remove>,
  ) {
    return this.removal.execute(memberCommand(request, input));
  }
}

@UseInterceptors(domainErrors(workspaceFailure))
@Controller()
export class WorkspaceController {
  public constructor(
    private readonly createWorkspace: CreateWorkspaceUseCase,
    private readonly lifecycle: WorkspaceLifecycleUseCase,
    private readonly renameWorkspace: RenameWorkspaceUseCase,
  ) {}

  @Route(routes.create)
  public async create(
    @Req() request: IdentityWorkspaceRequest,
    @In() { body, idempotencyKey }: RouteInput<typeof routes.create>,
  ) {
    return this.createWorkspace.execute({
      actorId: authenticatedSession(request).userId,
      idempotencyKey,
      request: body,
      requestId: requestIdentifier(request),
      ...traceFields(traceIdentifier(request)),
    });
  }

  @Route(routes.rename)
  public async rename(
    @Req() request: IdentityWorkspaceRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.rename>,
  ) {
    const actor = actorFrom(request, params.workspaceId);
    return this.renameWorkspace.execute({
      actor,
      routeWorkspaceId: params.workspaceId,
      request: body,
      idempotencyKey,
      requestId: actor.requestId,
      ...traceFields(actor.traceId),
    });
  }

  @Route(routes.requestDeletion)
  public async requestDeletion(
    @Req() request: IdentityWorkspaceRequest,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.requestDeletion>,
  ) {
    return this.lifecycle.requestDeletion({
      ...lifecycleCommand(request, params.workspaceId, idempotencyKey),
      reason: body.reason,
    });
  }

  @Route(routes.restore)
  public async restore(
    @Req() request: IdentityWorkspaceRequest,
    @In() { params, idempotencyKey }: RouteInput<typeof routes.restore>,
  ) {
    return this.lifecycle.restore(
      lifecycleCommand(request, params.workspaceId, idempotencyKey),
    );
  }

  @Route(routes.reactivate)
  public async reactivate(
    @Req() request: IdentityWorkspaceRequest,
    @In() { params, idempotencyKey }: RouteInput<typeof routes.reactivate>,
  ) {
    return this.lifecycle.reactivate(
      lifecycleCommand(request, params.workspaceId, idempotencyKey),
    );
  }
}

/** Who changes the workspace's lifecycle, with what the guard proved. */
function lifecycleCommand(
  request: IdentityWorkspaceRequest,
  workspaceId: string,
  idempotencyKey: string,
) {
  const actor = actorFrom(request, workspaceId);
  return {
    actor,
    ...optionalAuthorizedWorkspace(request),
    idempotencyKey,
    routeWorkspaceId: workspaceId,
    requestId: actor.requestId,
    ...traceFields(actor.traceId),
  };
}

function actorFrom(request: IdentityWorkspaceRequest, workspaceId: string) {
  return projectAuthenticatedWorkspaceContext(request, workspaceId).actor;
}

function traceFields(trace: string | undefined): Readonly<{
  traceId?: string;
}> {
  return trace === undefined ? {} : { traceId: trace };
}
