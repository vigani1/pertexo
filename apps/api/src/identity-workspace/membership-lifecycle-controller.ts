import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { OpaqueSessionService } from '../identity/index.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { memberCommand, selfCommand } from './controllers.js';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  WorkspaceManageGuard,
  WorkspaceMemberManageGuard,
  WorkspaceMembershipGuard,
  requireSignInEvidence,
} from './guards.js';
import { WorkspaceMembershipLifecycleUseCase } from './membership-lifecycle-use-case.js';
import type { IdentitySessionAuthority } from './ports.js';
import type { IdentityWorkspaceRequest } from './types.js';

/**
 * ADR 047 membership lifecycle: leave a workspace, suspend or reactivate a
 * member, and transfer ownership. Guards authorize the route; persistence
 * rechecks the actor, target and revisions under lock.
 */
@Controller('v1/workspaces')
export class WorkspaceMembershipController {
  public constructor(
    private readonly lifecycle: WorkspaceMembershipLifecycleUseCase,
    @Inject(OpaqueSessionService)
    private readonly sessions: IdentitySessionAuthority,
  ) {}

  @Post(':workspaceId/leave')
  @HttpCode(200)
  @RateLimit('ordinary_mutation')
  @UseGuards(
    SessionAuthenticationGuard,
    CsrfProtectionGuard,
    WorkspaceMembershipGuard,
  )
  public async leave(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.lifecycle.leave(selfCommand(request, params, body));
  }

  @Post(':workspaceId/members/:userId/suspend')
  @HttpCode(200)
  @RateLimit('ordinary_mutation')
  @UseGuards(
    SessionAuthenticationGuard,
    CsrfProtectionGuard,
    WorkspaceMemberManageGuard,
  )
  public async suspend(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.lifecycle.suspend(memberCommand(request, params, body));
  }

  @Post(':workspaceId/members/:userId/reactivate')
  @HttpCode(200)
  @RateLimit('ordinary_mutation')
  @UseGuards(
    SessionAuthenticationGuard,
    CsrfProtectionGuard,
    WorkspaceMemberManageGuard,
  )
  public async reactivate(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.lifecycle.reactivate(memberCommand(request, params, body));
  }

  /** Owner only, from a sign-in in the last five minutes. */
  @Post(':workspaceId/members/:userId/transfer-ownership')
  @HttpCode(200)
  @RateLimit('ordinary_mutation')
  @UseGuards(
    SessionAuthenticationGuard,
    CsrfProtectionGuard,
    WorkspaceManageGuard,
  )
  public async transferOwnership(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const command = memberCommand(request, params, body);
    const evidence = await requireSignInEvidence(request, this.sessions);
    return this.lifecycle.transferOwnership({
      ...command,
      signedInAt: evidence.signedInAt,
    });
  }
}
