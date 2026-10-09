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
} from './controllers.js';
import { SessionController } from './auth-controllers.js';
import { WorkspaceInvitationsController } from './invitation-management-controller.js';
import { WorkspaceInvitationManagementUseCase } from './invitation-management-use-cases.js';
import { InvitationAcceptanceController } from './invitation-acceptance-controller.js';
import { InvitationAcceptanceUseCase } from './invitation-acceptance-use-case.js';
import { RemoveWorkspaceMemberUseCase } from './member-removal-use-case.js';
import { WorkspaceMembershipController } from './membership-lifecycle-controller.js';
import { WorkspaceMembershipLifecycleUseCase } from './membership-lifecycle-use-case.js';
import { UpdateUserProfileUseCase } from './user-profile-use-case.js';
import { RenameWorkspaceUseCase } from './workspace-rename-use-case.js';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  WorkspaceManageGuard,
  WorkspaceMemberManageGuard,
  WorkspaceMemberReadGuard,
  WorkspaceMembershipGuard,
} from './guards.js';
import {
  CreateWorkspaceUseCase,
  ChangeWorkspaceMemberRoleUseCase,
  GetCurrentUserUseCase,
  ListAccessibleWorkspacesUseCase,
  ListWorkspaceMembersUseCase,
  WorkspaceLifecycleUseCase,
} from './use-cases.js';
import type {
  IdentityWorkspaceDependencies,
  IdentitySessionAuthority,
  InvitationTokenProtector,
} from './ports.js';
import {
  acceptancePersistence,
  invitationPersistence,
  memberRemovalPersistence,
  membershipLifecyclePersistence,
  missingInvitationTokenProtector,
  profilePersistence,
  renamePersistence,
} from './persistence-capabilities.js';
import {
  CSRF_POLICY,
  IDENTITY_CLOCK,
  IDENTITY_CRYPTO,
  IDENTITY_WORKSPACE_PERSISTENCE,
  WORKSPACE_AUTHORIZATION,
  SESSION_AUTHORITY,
  SESSION_COOKIE_POLICY,
  IDENTITY_WORKSPACE_TELEMETRY,
  INVITATION_TOKEN_PROTECTOR,
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
        provide: INVITATION_TOKEN_PROTECTOR,
        useValue:
          dependencies.invitationTokens ?? missingInvitationTokenProtector,
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
        provide: CreateWorkspaceUseCase,
        useFactory: (
          persistence: IdentityWorkspaceDependencies['persistence'],
          telemetry: IdentityWorkspaceTelemetry,
        ) => new CreateWorkspaceUseCase(persistence, telemetry),
        inject: [IDENTITY_WORKSPACE_PERSISTENCE, IDENTITY_WORKSPACE_TELEMETRY],
      },
      {
        provide: RenameWorkspaceUseCase,
        useFactory: (
          persistence: IdentityWorkspaceDependencies['persistence'],
          telemetry: IdentityWorkspaceTelemetry,
        ) =>
          new RenameWorkspaceUseCase(renamePersistence(persistence), telemetry),
        inject: [IDENTITY_WORKSPACE_PERSISTENCE, IDENTITY_WORKSPACE_TELEMETRY],
      },
      {
        provide: WorkspaceLifecycleUseCase,
        useFactory: (
          persistence: IdentityWorkspaceDependencies['persistence'],
          authorization: IdentityWorkspaceDependencies['authorization'],
          telemetry: IdentityWorkspaceTelemetry,
        ) =>
          new WorkspaceLifecycleUseCase(persistence, authorization, telemetry),
        inject: [
          IDENTITY_WORKSPACE_PERSISTENCE,
          WORKSPACE_AUTHORIZATION,
          IDENTITY_WORKSPACE_TELEMETRY,
        ],
      },
      ...identityReadProviders(),
      {
        provide: WorkspaceInvitationManagementUseCase,
        useFactory: (
          persistence: IdentityWorkspaceDependencies['persistence'],
          invitationTokens: InvitationTokenProtector,
          identityCrypto: IdentityCrypto,
          identityClock: IdentityClock,
        ) =>
          new WorkspaceInvitationManagementUseCase(
            invitationPersistence(persistence),
            invitationTokens,
            identityCrypto,
            identityClock,
          ),
        inject: [
          IDENTITY_WORKSPACE_PERSISTENCE,
          INVITATION_TOKEN_PROTECTOR,
          IDENTITY_CRYPTO,
          IDENTITY_CLOCK,
        ],
      },
      {
        provide: InvitationAcceptanceUseCase,
        useFactory: (
          persistence: IdentityWorkspaceDependencies['persistence'],
          identityCrypto: IdentityCrypto,
          identityClock: IdentityClock,
        ) =>
          new InvitationAcceptanceUseCase(
            acceptancePersistence(persistence),
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
        SESSION_AUTHORITY,
        CSRF_POLICY,
        DoubleSubmitCsrfPolicy,
        CreateWorkspaceUseCase,
        RenameWorkspaceUseCase,
        WorkspaceLifecycleUseCase,
        GetCurrentUserUseCase,
        ListAccessibleWorkspacesUseCase,
        ListWorkspaceMembersUseCase,
        ChangeWorkspaceMemberRoleUseCase,
        RemoveWorkspaceMemberUseCase,
        WorkspaceMembershipLifecycleUseCase,
        UpdateUserProfileUseCase,
        WorkspaceInvitationManagementUseCase,
        InvitationAcceptanceUseCase,
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
      provide: ChangeWorkspaceMemberRoleUseCase,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        telemetry: IdentityWorkspaceTelemetry,
      ) => new ChangeWorkspaceMemberRoleUseCase(persistence, telemetry),
      inject: [IDENTITY_WORKSPACE_PERSISTENCE, IDENTITY_WORKSPACE_TELEMETRY],
    },
    {
      provide: RemoveWorkspaceMemberUseCase,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        telemetry: IdentityWorkspaceTelemetry,
      ) =>
        new RemoveWorkspaceMemberUseCase(
          memberRemovalPersistence(persistence),
          telemetry,
        ),
      inject: [IDENTITY_WORKSPACE_PERSISTENCE, IDENTITY_WORKSPACE_TELEMETRY],
    },
    {
      provide: WorkspaceMembershipLifecycleUseCase,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        clock: IdentityClock,
        telemetry: IdentityWorkspaceTelemetry,
      ) =>
        new WorkspaceMembershipLifecycleUseCase(
          membershipLifecyclePersistence(persistence),
          clock,
          telemetry,
        ),
      inject: [
        IDENTITY_WORKSPACE_PERSISTENCE,
        IDENTITY_CLOCK,
        IDENTITY_WORKSPACE_TELEMETRY,
      ],
    },
    {
      provide: UpdateUserProfileUseCase,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        telemetry: IdentityWorkspaceTelemetry,
      ) =>
        new UpdateUserProfileUseCase(
          profilePersistence(persistence),
          telemetry,
        ),
      inject: [IDENTITY_WORKSPACE_PERSISTENCE, IDENTITY_WORKSPACE_TELEMETRY],
    },
    {
      provide: ListAccessibleWorkspacesUseCase,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        telemetry: IdentityWorkspaceTelemetry,
      ) => new ListAccessibleWorkspacesUseCase(persistence, telemetry),
      inject: [IDENTITY_WORKSPACE_PERSISTENCE, IDENTITY_WORKSPACE_TELEMETRY],
    },
    {
      provide: GetCurrentUserUseCase,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        telemetry: IdentityWorkspaceTelemetry,
      ) => new GetCurrentUserUseCase(persistence, telemetry),
      inject: [IDENTITY_WORKSPACE_PERSISTENCE, IDENTITY_WORKSPACE_TELEMETRY],
    },
    {
      provide: ListWorkspaceMembersUseCase,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        authorization: IdentityWorkspaceDependencies['authorization'],
        telemetry: IdentityWorkspaceTelemetry,
      ) =>
        new ListWorkspaceMembersUseCase(persistence, authorization, telemetry),
      inject: [
        IDENTITY_WORKSPACE_PERSISTENCE,
        WORKSPACE_AUTHORIZATION,
        IDENTITY_WORKSPACE_TELEMETRY,
      ],
    },
  ];
}
