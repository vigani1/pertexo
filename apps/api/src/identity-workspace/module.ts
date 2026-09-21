import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import {
  DoubleSubmitCsrfPolicy,
  OidcLoginService,
  OpaqueSessionService,
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
import { OidcController, SessionController } from './auth-controllers.js';
import { WorkspaceInvitationsController } from './invitation-management-controller.js';
import { WorkspaceInvitationManagementUseCase } from './invitation-management-use-cases.js';
import { InvitationAcceptanceController } from './invitation-acceptance-controller.js';
import { InvitationAcceptanceUseCase } from './invitation-acceptance-use-case.js';
import { RenameWorkspaceUseCase } from './workspace-rename-use-case.js';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  WorkspaceManageGuard,
  WorkspaceMemberManageGuard,
  WorkspaceMemberReadGuard,
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
  IdentityWorkspacePersistence,
  InvitationTokenProtector,
} from './ports.js';
import {
  CSRF_POLICY,
  IDENTITY_CLOCK,
  IDENTITY_CRYPTO,
  IDENTITY_WORKSPACE_CONFIG,
  IDENTITY_WORKSPACE_PERSISTENCE,
  OIDC_PROVIDER,
  OIDC_CALLBACK_LANDING_PATH,
  OIDC_TRANSACTIONS,
  WORKSPACE_AUTHORIZATION,
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
      { provide: IDENTITY_WORKSPACE_CONFIG, useValue: dependencies.config },
      {
        provide: INVITATION_ALLOWED_ORIGIN,
        useValue:
          dependencies.config.publicWebOrigin ??
          new URL(dependencies.config.oidc.redirectUri).origin,
      },
      { provide: IDENTITY_CRYPTO, useValue: crypto },
      { provide: IDENTITY_CLOCK, useValue: clock },
      {
        provide: IDENTITY_WORKSPACE_TELEMETRY,
        useValue: dependencies.telemetry ?? NOOP_IDENTITY_WORKSPACE_TELEMETRY,
      },
      { provide: OIDC_PROVIDER, useValue: dependencies.provider },
      {
        provide: OIDC_CALLBACK_LANDING_PATH,
        useValue: dependencies.config.oidc.callbackLandingPath ?? '/',
      },
      { provide: OIDC_TRANSACTIONS, useValue: dependencies.transactions },
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
      {
        provide: OidcLoginService,
        useFactory: (
          config: IdentityWorkspaceDependencies['config'],
          transactions: IdentityWorkspaceDependencies['transactions'],
          provider: IdentityWorkspaceDependencies['provider'],
          persistence: IdentityWorkspaceDependencies['persistence'],
          crypto: IdentityCrypto,
          clock: IdentityClock,
        ): OidcLoginService =>
          new OidcLoginService(
            config.oidc,
            transactions,
            provider,
            {
              mapExternalIdentity: async (identity, profile) =>
                persistence.resolveOrCreateIdentity({
                  issuer: identity.issuer,
                  providerSubject: identity.subject,
                  email: profile.email,
                  displayName: profile.displayName,
                }),
            },
            { crypto, clock },
          ),
        inject: [
          IDENTITY_WORKSPACE_CONFIG,
          OIDC_TRANSACTIONS,
          OIDC_PROVIDER,
          IDENTITY_WORKSPACE_PERSISTENCE,
          IDENTITY_CRYPTO,
          IDENTITY_CLOCK,
        ],
      },
      {
        provide: OpaqueSessionService,
        useFactory: (
          persistence: IdentityWorkspaceDependencies['persistence'],
          config: IdentityWorkspaceDependencies['config'],
          crypto: IdentityCrypto,
          clock: IdentityClock,
        ): OpaqueSessionService =>
          new OpaqueSessionService(persistence, {
            ...config.session,
            crypto,
            clock,
          }),
        inject: [
          IDENTITY_WORKSPACE_PERSISTENCE,
          IDENTITY_WORKSPACE_CONFIG,
          IDENTITY_CRYPTO,
          IDENTITY_CLOCK,
        ],
      },
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
          oidc: OidcLoginService,
          identityCrypto: IdentityCrypto,
          identityClock: IdentityClock,
          config: IdentityWorkspaceDependencies['config'],
        ) =>
          new InvitationAcceptanceUseCase(
            acceptancePersistence(persistence),
            oidc,
            identityCrypto,
            identityClock,
            config,
          ),
        inject: [
          IDENTITY_WORKSPACE_PERSISTENCE,
          OidcLoginService,
          IDENTITY_CRYPTO,
          IDENTITY_CLOCK,
          IDENTITY_WORKSPACE_CONFIG,
        ],
      },
      {
        provide: SessionAuthenticationGuard,
        useFactory: (
          sessions: OpaqueSessionService,
          contexts: RequestContextStore,
        ) => new SessionAuthenticationGuard(sessions, contexts),
        inject: [OpaqueSessionService, RequestContextStore],
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
    ];
    return {
      module: IdentityWorkspaceModule,
      controllers: [
        OidcController,
        SessionController,
        UserController,
        WorkspaceDiscoveryController,
        WorkspaceMembersController,
        WorkspaceInvitationsController,
        InvitationAcceptanceController,
        WorkspaceController,
      ],
      providers,
      exports: [
        OidcLoginService,
        OpaqueSessionService,
        CSRF_POLICY,
        DoubleSubmitCsrfPolicy,
        CreateWorkspaceUseCase,
        RenameWorkspaceUseCase,
        WorkspaceLifecycleUseCase,
        GetCurrentUserUseCase,
        ListAccessibleWorkspacesUseCase,
        ListWorkspaceMembersUseCase,
        ChangeWorkspaceMemberRoleUseCase,
        WorkspaceInvitationManagementUseCase,
        InvitationAcceptanceUseCase,
        SessionAuthenticationGuard,
        CsrfProtectionGuard,
        WorkspaceManageGuard,
        WorkspaceMemberManageGuard,
        WorkspaceMemberReadGuard,
      ],
    };
  }
}

const missingInvitationTokenProtector: InvitationTokenProtector = Object.freeze(
  {
    seal: () => {
      throw new Error('Invitation token protection is not configured');
    },
  },
);

type InvitationPersistence = Required<
  Pick<
    IdentityWorkspacePersistence,
    | 'listWorkspaceInvitations'
    | 'createWorkspaceInvitation'
    | 'resendWorkspaceInvitation'
    | 'revokeWorkspaceInvitation'
  >
>;
type RenamePersistence = Required<
  Pick<IdentityWorkspacePersistence, 'renameWorkspace'>
>;

function renamePersistence(
  persistence: IdentityWorkspacePersistence,
): RenamePersistence {
  return persistence.renameWorkspace === undefined
    ? missingRenamePersistence
    : Object.freeze({
        renameWorkspace: persistence.renameWorkspace.bind(persistence),
      });
}

const missingRenamePersistence: RenamePersistence = Object.freeze({
  renameWorkspace: () =>
    Promise.reject(new Error('Workspace rename persistence is not configured')),
});

type AcceptancePersistence = Required<
  Pick<
    IdentityWorkspacePersistence,
    | 'resolveInvitationAcceptance'
    | 'readInvitationAcceptance'
    | 'recordInvitationAcceptanceProof'
    | 'completeInvitationAcceptance'
    | 'abandonInvitationAcceptance'
  >
>;

function invitationPersistence(
  persistence: IdentityWorkspacePersistence,
): InvitationPersistence {
  if (
    persistence.listWorkspaceInvitations === undefined ||
    persistence.createWorkspaceInvitation === undefined ||
    persistence.resendWorkspaceInvitation === undefined ||
    persistence.revokeWorkspaceInvitation === undefined
  )
    return missingInvitationPersistence;
  return Object.freeze({
    listWorkspaceInvitations:
      persistence.listWorkspaceInvitations.bind(persistence),
    createWorkspaceInvitation:
      persistence.createWorkspaceInvitation.bind(persistence),
    resendWorkspaceInvitation:
      persistence.resendWorkspaceInvitation.bind(persistence),
    revokeWorkspaceInvitation:
      persistence.revokeWorkspaceInvitation.bind(persistence),
  });
}

const missingInvitationPersistence: InvitationPersistence = Object.freeze({
  listWorkspaceInvitations: () =>
    Promise.reject(new Error('Invitation persistence is not configured')),
  createWorkspaceInvitation: () =>
    Promise.reject(new Error('Invitation persistence is not configured')),
  resendWorkspaceInvitation: () =>
    Promise.reject(new Error('Invitation persistence is not configured')),
  revokeWorkspaceInvitation: () =>
    Promise.reject(new Error('Invitation persistence is not configured')),
});

function acceptancePersistence(
  persistence: IdentityWorkspacePersistence,
): AcceptancePersistence {
  if (
    persistence.resolveInvitationAcceptance === undefined ||
    persistence.readInvitationAcceptance === undefined ||
    persistence.recordInvitationAcceptanceProof === undefined ||
    persistence.completeInvitationAcceptance === undefined ||
    persistence.abandonInvitationAcceptance === undefined
  )
    return missingAcceptancePersistence;
  return Object.freeze({
    resolveInvitationAcceptance:
      persistence.resolveInvitationAcceptance.bind(persistence),
    readInvitationAcceptance:
      persistence.readInvitationAcceptance.bind(persistence),
    recordInvitationAcceptanceProof:
      persistence.recordInvitationAcceptanceProof.bind(persistence),
    completeInvitationAcceptance:
      persistence.completeInvitationAcceptance.bind(persistence),
    abandonInvitationAcceptance:
      persistence.abandonInvitationAcceptance.bind(persistence),
  });
}

const missingAcceptancePersistence: AcceptancePersistence = Object.freeze({
  resolveInvitationAcceptance: () =>
    Promise.reject(
      new Error('Invitation acceptance persistence is not configured'),
    ),
  readInvitationAcceptance: () =>
    Promise.reject(
      new Error('Invitation acceptance persistence is not configured'),
    ),
  recordInvitationAcceptanceProof: () =>
    Promise.reject(
      new Error('Invitation acceptance persistence is not configured'),
    ),
  completeInvitationAcceptance: () =>
    Promise.reject(
      new Error('Invitation acceptance persistence is not configured'),
    ),
  abandonInvitationAcceptance: () =>
    Promise.reject(
      new Error('Invitation acceptance persistence is not configured'),
    ),
});

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
