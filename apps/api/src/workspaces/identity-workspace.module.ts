import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import {
  DoubleSubmitCsrfPolicy,
  nodeIdentityCrypto,
} from '../identity/index.js';
import type { IdentityClock, IdentityCrypto } from '../identity/index.js';
import { RequestContextStore } from '../platform/http/index.js';
import {
  UserController,
  WorkspaceDiscoveryController,
  WorkspaceMembersController,
  WorkspaceController,
} from './http/workspaces.controller.js';
import { SessionController } from './http/session.controller.js';
import { WorkspaceInvitationsController } from './invitations/management.controller.js';
import { WorkspaceInvitationManagementService } from './invitations/management.js';
import { InvitationAcceptanceController } from './invitations/acceptance.controller.js';
import { InvitationAcceptanceService } from './invitations/acceptance.js';
import { RemoveWorkspaceMemberService } from './members/removal.js';
import { WorkspaceMembershipController } from './members/lifecycle.controller.js';
import { WorkspaceMembershipLifecycleService } from './members/lifecycle.js';
import { UpdateUserProfileService } from './commands/user-profile.js';
import { RenameWorkspaceService } from './commands/rename.js';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  WorkspaceManageGuard,
  WorkspaceMemberManageGuard,
  WorkspaceMemberReadGuard,
  WorkspaceMembershipGuard,
} from './http/guards.js';
import {
  CreateWorkspaceService,
  ChangeWorkspaceMemberRoleService,
  GetCurrentUserService,
  ListAccessibleWorkspacesService,
  ListWorkspaceMembersService,
  WorkspaceLifecycleService,
} from './workspaces.service.js';
import type {
  IdentityWorkspaceDependencies,
  IdentitySessionAuthority,
} from './ports.js';

import {
  CSRF_POLICY,
  IDENTITY_CLOCK,
  IDENTITY_CRYPTO,
  IDENTITY_WORKSPACE_PERSISTENCE,
  WORKSPACE_AUTHORIZATION,
  SESSION_AUTHORITY,
  SESSION_COOKIE_POLICY,
  IDENTITY_WORKSPACE_TELEMETRY,
  INVITATION_ALLOWED_ORIGIN,
} from './tokens.js';
import {
  NOOP_IDENTITY_WORKSPACE_TELEMETRY,
  type IdentityWorkspaceTelemetry,
} from './telemetry.js';

@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class IdentityWorkspaceModule {
  public static register(
    dependencies: IdentityWorkspaceDependencies,
  ): DynamicModule {
    const crypto: IdentityCrypto = dependencies.crypto ?? nodeIdentityCrypto;
    const clock: IdentityClock = dependencies.clock ?? {
      now: (): Date => new Date(),
    };
    const providers: Provider[] = [
      ...identityCoreProviders(dependencies, crypto, clock),
      ...identityReadProviders(),
      {
        provide: WorkspaceInvitationManagementService,
        useFactory: (
          persistence: IdentityWorkspaceDependencies['persistence'],
          identityCrypto: IdentityCrypto,
        ) =>
          new WorkspaceInvitationManagementService(
            persistence,
            dependencies.invitationTokens,
            identityCrypto,
          ),
        inject: [IDENTITY_WORKSPACE_PERSISTENCE, IDENTITY_CRYPTO],
      },
      {
        provide: InvitationAcceptanceService,
        useFactory: (
          persistence: IdentityWorkspaceDependencies['persistence'],
          identityCrypto: IdentityCrypto,
          identityClock: IdentityClock,
        ) =>
          new InvitationAcceptanceService(
            persistence,
            identityCrypto,
            identityClock,
            dependencies.config,
          ),
        inject: [
          IDENTITY_WORKSPACE_PERSISTENCE,
          IDENTITY_CRYPTO,
          IDENTITY_CLOCK,
        ],
      },
      {
        provide: SessionAuthenticationGuard,
        useFactory: (
          sessions: IdentitySessionAuthority,
          contexts: RequestContextStore,
        ) => new SessionAuthenticationGuard(sessions, contexts),
        inject: [SESSION_AUTHORITY, RequestContextStore],
      },
      {
        provide: CsrfProtectionGuard,
        useFactory: (csrf: DoubleSubmitCsrfPolicy) =>
          new CsrfProtectionGuard(csrf),
        inject: [CSRF_POLICY],
      },
      WorkspaceManageGuard,
      WorkspaceMemberManageGuard,
      WorkspaceMemberReadGuard,
      WorkspaceMembershipGuard,
    ];
    return {
      module: IdentityWorkspaceModule,
      controllers: [
        SessionController,
        UserController,
        WorkspaceDiscoveryController,
        WorkspaceMembersController,
        WorkspaceMembershipController,
        WorkspaceInvitationsController,
        WorkspaceController,
        InvitationAcceptanceController,
      ],
      providers,
      exports: [
        WORKSPACE_AUTHORIZATION,
        SESSION_AUTHORITY,
        CSRF_POLICY,
        DoubleSubmitCsrfPolicy,
        CreateWorkspaceService,
        RenameWorkspaceService,
        WorkspaceLifecycleService,
        GetCurrentUserService,
        ListAccessibleWorkspacesService,
        ListWorkspaceMembersService,
        ChangeWorkspaceMemberRoleService,
        RemoveWorkspaceMemberService,
        WorkspaceMembershipLifecycleService,
        UpdateUserProfileService,
        WorkspaceInvitationManagementService,
        InvitationAcceptanceService,
        SessionAuthenticationGuard,
        CsrfProtectionGuard,
        WorkspaceManageGuard,
        WorkspaceMemberManageGuard,
        WorkspaceMemberReadGuard,
        WorkspaceMembershipGuard,
      ],
    };
  }
}

function identityReadProviders(): Provider[] {
  return [
    {
      provide: ChangeWorkspaceMemberRoleService,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        telemetry: IdentityWorkspaceTelemetry,
      ) => new ChangeWorkspaceMemberRoleService(persistence, telemetry),
      inject: [IDENTITY_WORKSPACE_PERSISTENCE, IDENTITY_WORKSPACE_TELEMETRY],
    },
    {
      provide: RemoveWorkspaceMemberService,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        telemetry: IdentityWorkspaceTelemetry,
      ) => new RemoveWorkspaceMemberService(persistence, telemetry),
      inject: [IDENTITY_WORKSPACE_PERSISTENCE, IDENTITY_WORKSPACE_TELEMETRY],
    },
    {
      provide: WorkspaceMembershipLifecycleService,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        clock: IdentityClock,
        telemetry: IdentityWorkspaceTelemetry,
      ) =>
        new WorkspaceMembershipLifecycleService(persistence, clock, telemetry),
      inject: [
        IDENTITY_WORKSPACE_PERSISTENCE,
        IDENTITY_CLOCK,
        IDENTITY_WORKSPACE_TELEMETRY,
      ],
    },
    {
      provide: UpdateUserProfileService,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        telemetry: IdentityWorkspaceTelemetry,
      ) => new UpdateUserProfileService(persistence, telemetry),
      inject: [IDENTITY_WORKSPACE_PERSISTENCE, IDENTITY_WORKSPACE_TELEMETRY],
    },
    {
      provide: ListAccessibleWorkspacesService,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        telemetry: IdentityWorkspaceTelemetry,
      ) => new ListAccessibleWorkspacesService(persistence, telemetry),
      inject: [IDENTITY_WORKSPACE_PERSISTENCE, IDENTITY_WORKSPACE_TELEMETRY],
    },
    {
      provide: GetCurrentUserService,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        telemetry: IdentityWorkspaceTelemetry,
      ) => new GetCurrentUserService(persistence, telemetry),
      inject: [IDENTITY_WORKSPACE_PERSISTENCE, IDENTITY_WORKSPACE_TELEMETRY],
    },
    {
      provide: ListWorkspaceMembersService,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        authorization: IdentityWorkspaceDependencies['authorization'],
        telemetry: IdentityWorkspaceTelemetry,
      ) =>
        new ListWorkspaceMembersService(persistence, authorization, telemetry),
      inject: [
        IDENTITY_WORKSPACE_PERSISTENCE,
        WORKSPACE_AUTHORIZATION,
        IDENTITY_WORKSPACE_TELEMETRY,
      ],
    },
  ];
}

function identityCoreProviders(
  dependencies: IdentityWorkspaceDependencies,
  crypto: IdentityCrypto,
  clock: IdentityClock,
): Provider[] {
  return [
    {
      provide: INVITATION_ALLOWED_ORIGIN,
      useValue: dependencies.config.publicWebOrigin,
    },
    { provide: IDENTITY_CRYPTO, useValue: crypto },
    { provide: IDENTITY_CLOCK, useValue: clock },
    {
      provide: IDENTITY_WORKSPACE_TELEMETRY,
      useValue: dependencies.telemetry ?? NOOP_IDENTITY_WORKSPACE_TELEMETRY,
    },
    {
      provide: IDENTITY_WORKSPACE_PERSISTENCE,
      useValue: dependencies.persistence,
    },
    {
      provide: WORKSPACE_AUTHORIZATION,
      useValue: dependencies.authorization,
    },
    {
      provide: SESSION_COOKIE_POLICY,
      useValue: {
        secure: dependencies.config.session?.secureCookie ?? true,
        sameSite: dependencies.config.session?.sameSite ?? 'lax',
      },
    },
    { provide: SESSION_AUTHORITY, useValue: dependencies.sessions },
    {
      provide: CSRF_POLICY,
      useFactory: (crypto: IdentityCrypto) =>
        new DoubleSubmitCsrfPolicy(crypto),
      inject: [IDENTITY_CRYPTO],
    },
    {
      provide: DoubleSubmitCsrfPolicy,
      useExisting: CSRF_POLICY,
    },
    {
      provide: CreateWorkspaceService,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        telemetry: IdentityWorkspaceTelemetry,
      ) => new CreateWorkspaceService(persistence, telemetry),
      inject: [IDENTITY_WORKSPACE_PERSISTENCE, IDENTITY_WORKSPACE_TELEMETRY],
    },
    {
      provide: RenameWorkspaceService,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        telemetry: IdentityWorkspaceTelemetry,
      ) => new RenameWorkspaceService(persistence, telemetry),
      inject: [IDENTITY_WORKSPACE_PERSISTENCE, IDENTITY_WORKSPACE_TELEMETRY],
    },
    {
      provide: WorkspaceLifecycleService,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        authorization: IdentityWorkspaceDependencies['authorization'],
        telemetry: IdentityWorkspaceTelemetry,
      ) => new WorkspaceLifecycleService(persistence, authorization, telemetry),
      inject: [
        IDENTITY_WORKSPACE_PERSISTENCE,
        WORKSPACE_AUTHORIZATION,
        IDENTITY_WORKSPACE_TELEMETRY,
      ],
    },
  ];
}
