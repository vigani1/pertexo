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
  IdentitySessionAuthority,
  InvitationTokenProtector,
} from './ports.js';
import {
  acceptancePersistence,
  invitationPersistence,
  missingInvitationTokenProtector,
  renamePersistence,
} from './persistence-capabilities.js';
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
    const oidc = completeOidcDependencies(dependencies);
    const crypto: IdentityCrypto = dependencies.crypto ?? nodeIdentityCrypto;
    const clock: IdentityClock = dependencies.clock ?? {
      now: (): Date => new Date(),
    };
    const providers: Provider[] = [
      { provide: IDENTITY_WORKSPACE_CONFIG, useValue: dependencies.config },
      {
        provide: INVITATION_ALLOWED_ORIGIN,
        useValue: identityPublicOrigin(dependencies.config),
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
      {
        provide: OpaqueSessionService,
        useFactory: (
          persistence: IdentityWorkspaceDependencies['persistence'],
          config: IdentityWorkspaceDependencies['config'],
          crypto: IdentityCrypto,
          clock: IdentityClock,
        ): IdentitySessionAuthority =>
          dependencies.sessions ??
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
      ...(oidc === undefined ? [] : oidcProviders(dependencies, oidc)),
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
        SessionController,
        UserController,
        WorkspaceDiscoveryController,
        WorkspaceMembersController,
        WorkspaceInvitationsController,
        WorkspaceController,
        ...(oidc === undefined
          ? []
          : [OidcController, InvitationAcceptanceController]),
      ],
      providers,
      exports: [
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
        SessionAuthenticationGuard,
        CsrfProtectionGuard,
        WorkspaceManageGuard,
        WorkspaceMemberManageGuard,
        WorkspaceMemberReadGuard,
        ...(oidc === undefined
          ? []
          : [OidcLoginService, InvitationAcceptanceUseCase]),
      ],
    };
  }
}

function identityPublicOrigin(
  config: IdentityWorkspaceDependencies['config'],
): string {
  if (config.publicWebOrigin !== undefined) return config.publicWebOrigin;
  if (config.oidc !== undefined) return new URL(config.oidc.redirectUri).origin;
  throw new TypeError('Identity public web origin is not configured');
}

type OidcDependencies = Readonly<{
  oidc: NonNullable<IdentityWorkspaceDependencies['config']['oidc']>;
  provider: NonNullable<IdentityWorkspaceDependencies['provider']>;
  transactions: NonNullable<IdentityWorkspaceDependencies['transactions']>;
}>;

/** Generic OIDC is wired only as a whole; a partial set is a composition error. */
function completeOidcDependencies(
  dependencies: IdentityWorkspaceDependencies,
): OidcDependencies | undefined {
  const { provider, transactions } = dependencies;
  const oidc = dependencies.config.oidc;
  if (
    oidc !== undefined &&
    provider !== undefined &&
    transactions !== undefined
  )
    return { oidc, provider, transactions };
  if (
    oidc !== undefined ||
    provider !== undefined ||
    transactions !== undefined
  )
    throw new TypeError(
      'OIDC configuration, provider, and transaction store must be supplied together',
    );
  return undefined;
}

function oidcProviders(
  dependencies: IdentityWorkspaceDependencies,
  { oidc, provider, transactions }: OidcDependencies,
): Provider[] {
  return [
    { provide: OIDC_PROVIDER, useValue: provider },
    {
      provide: OIDC_CALLBACK_LANDING_PATH,
      useValue: oidc.callbackLandingPath ?? '/',
    },
    { provide: OIDC_TRANSACTIONS, useValue: transactions },
    {
      provide: OidcLoginService,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        crypto: IdentityCrypto,
        clock: IdentityClock,
      ): OidcLoginService =>
        new OidcLoginService(
          oidc,
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
          {
            crypto,
            clock,
            allowGenericLogin:
              dependencies.config.allowGenericOidcLogin !== false,
          },
        ),
      inject: [IDENTITY_WORKSPACE_PERSISTENCE, IDENTITY_CRYPTO, IDENTITY_CLOCK],
    },
    {
      provide: InvitationAcceptanceUseCase,
      useFactory: (
        persistence: IdentityWorkspaceDependencies['persistence'],
        login: OidcLoginService,
        identityCrypto: IdentityCrypto,
        identityClock: IdentityClock,
      ) =>
        new InvitationAcceptanceUseCase(
          acceptancePersistence(persistence),
          login,
          identityCrypto,
          identityClock,
          dependencies.config,
        ),
      inject: [
        IDENTITY_WORKSPACE_PERSISTENCE,
        OidcLoginService,
        IDENTITY_CRYPTO,
        IDENTITY_CLOCK,
      ],
    },
  ];
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
