import { Controller, Inject, Req, UseInterceptors } from '@nestjs/common';
import {
  workspaceRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { memberCommand } from '../request/member-commands.js';
import { requireSignInEvidence } from '../http/guards.js';
import { In, Route } from '../http/route.js';
import { WorkspaceMembershipLifecycleUseCase } from './lifecycle.js';
import type { IdentitySessionAuthority } from '../ports.js';
import { SESSION_AUTHORITY } from '../tokens.js';
import type { IdentityWorkspaceRequest } from '../workspace-transport.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { workspaceFailure } from '../../problems/context/normalize.js';

/**
 * ADR 047 membership lifecycle: leave a workspace, suspend or reactivate a
 * member, and transfer ownership. Guards authorize the route; persistence
 * rechecks the actor, target and revisions under lock.
 */
@UseInterceptors(domainErrors(workspaceFailure))
@Controller()
export class WorkspaceMembershipController {
  public constructor(
    private readonly lifecycle: WorkspaceMembershipLifecycleUseCase,
    @Inject(SESSION_AUTHORITY)
    private readonly sessions: IdentitySessionAuthority,
  ) {}

  @Route(routes.leave)
  public async leave(
    @Req() request: IdentityWorkspaceRequest,
    @In() input: RouteInput<typeof routes.leave>,
  ) {
    return this.lifecycle.leave(memberCommand(request, input));
  }

  @Route(routes.suspend)
  public async suspend(
    @Req() request: IdentityWorkspaceRequest,
    @In() input: RouteInput<typeof routes.suspend>,
  ) {
    return this.lifecycle.suspend(memberCommand(request, input));
  }

  @Route(routes.reactivateMember)
  public async reactivate(
    @Req() request: IdentityWorkspaceRequest,
    @In() input: RouteInput<typeof routes.reactivateMember>,
  ) {
    return this.lifecycle.reactivate(memberCommand(request, input));
  }

  /** Owner only, from a sign-in in the last five minutes. */
  @Route(routes.transferOwnership)
  public async transferOwnership(
    @Req() request: IdentityWorkspaceRequest,
    @In() input: RouteInput<typeof routes.transferOwnership>,
  ) {
    const command = memberCommand(request, input);
    const evidence = await requireSignInEvidence(request, this.sessions);
    return this.lifecycle.transferOwnership({
      ...command,
      signedInAt: evidence.signedInAt,
    });
  }
}
