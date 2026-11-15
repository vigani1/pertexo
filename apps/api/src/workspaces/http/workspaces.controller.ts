import { Controller, Req, UseInterceptors } from '@nestjs/common';
import { sessionRoutes } from '@pertexo/contracts/server';

import {
  workspaceRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { workspaceFailure } from '../../problems/context/normalize-context-errors.js';
import { RenameWorkspaceService } from '../commands/rename.js';
import { UpdateUserProfileService } from '../commands/user-profile.js';
import { RemoveWorkspaceMemberService } from '../members/removal.js';
import { requestIdentifier, traceIdentifier } from '../request/identifiers.js';
import { memberCommand } from '../request/member-commands.js';
import type { IdentityWorkspaceRequest } from '../workspace-transport.js';
import {
  ChangeWorkspaceMemberRoleService,
  CreateWorkspaceService,
  GetCurrentUserService,
  ListAccessibleWorkspacesService,
  ListWorkspaceMembersService,
  WorkspaceLifecycleService,
} from '../workspaces.service.js';
import { authenticatedSession } from './guards.js';
import { In, Route } from '../../platform/http/route.js';
import {
  Caller,
  serviceCaller,
  requestIdentifiers,
  type WorkspaceCaller,
} from '../request/caller.js';

@UseInterceptors(domainErrors(workspaceFailure))
@Controller()
export class UserController {
  public constructor(
    private readonly currentUser: GetCurrentUserService,
    private readonly profile: UpdateUserProfileService,
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
    private readonly workspaces: ListAccessibleWorkspacesService,
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
    private readonly members: ListWorkspaceMembersService,
    private readonly roleChange: ChangeWorkspaceMemberRoleService,
    private readonly removal: RemoveWorkspaceMemberService,
  ) {}

  @Route(routes.members)
  public async list(
    @Caller() caller: WorkspaceCaller,
    @In() { query }: RouteInput<typeof routes.members>,
  ) {
    return this.members.execute({
      ...serviceCaller(caller),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.after === undefined ? {} : { after: query.after }),
    });
  }

  @Route(routes.changeRole)
  public async changeRole(
    @Caller() caller: WorkspaceCaller,
    @In() input: RouteInput<typeof routes.changeRole>,
  ) {
    return this.roleChange.execute(memberCommand(caller, input));
  }

  @Route(routes.remove)
  public async remove(
    @Caller() caller: WorkspaceCaller,
    @In() input: RouteInput<typeof routes.remove>,
  ) {
    return this.removal.execute(memberCommand(caller, input));
  }
}

@UseInterceptors(domainErrors(workspaceFailure))
@Controller()
export class WorkspaceController {
  public constructor(
    private readonly createWorkspace: CreateWorkspaceService,
    private readonly lifecycle: WorkspaceLifecycleService,
    private readonly renameWorkspace: RenameWorkspaceService,
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
    @Caller() caller: WorkspaceCaller,
    @In() { body, idempotencyKey }: RouteInput<typeof routes.rename>,
  ) {
    return this.renameWorkspace.execute({
      actor: caller.actor,
      routeWorkspaceId: caller.workspaceId,
      request: body,
      idempotencyKey,
      ...requestIdentifiers(caller),
    });
  }

  @Route(routes.requestDeletion)
  public async requestDeletion(
    @Caller() caller: WorkspaceCaller,
    @In()
    { body, idempotencyKey }: RouteInput<typeof routes.requestDeletion>,
  ) {
    return this.lifecycle.requestDeletion({
      ...lifecycleCommand(caller, idempotencyKey),
      reason: body.reason,
    });
  }

  @Route(routes.restore)
  public async restore(
    @Caller() caller: WorkspaceCaller,
    @In() { idempotencyKey }: RouteInput<typeof routes.restore>,
  ) {
    return this.lifecycle.restore(lifecycleCommand(caller, idempotencyKey));
  }

  @Route(routes.reactivate)
  public async reactivate(
    @Caller() caller: WorkspaceCaller,
    @In() { idempotencyKey }: RouteInput<typeof routes.reactivate>,
  ) {
    return this.lifecycle.reactivate(lifecycleCommand(caller, idempotencyKey));
  }
}

/** Who changes the workspace's lifecycle, with what the guard proved. */
function lifecycleCommand(caller: WorkspaceCaller, idempotencyKey: string) {
  return { ...serviceCaller(caller), idempotencyKey };
}

function traceFields(trace: string | undefined): Readonly<{
  traceId?: string;
}> {
  return trace === undefined ? {} : { traceId: trace };
}
